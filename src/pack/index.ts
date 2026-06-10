import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { assertWritePathIsSafe, writeTextFileSafely } from "../fs-safety.js";

export interface BuildPackOptions {
	cwd?: string;
	out: string;
}

export interface InspectPackOptions {
	path: string;
}

export interface VerifyPackOptions {
	path: string;
}

export interface InstallPackOptions {
	path: string;
	cwd?: string;
	write?: boolean;
}

export interface PackEntry {
	path: string;
	kind: string;
	sha256: string;
	byteLength: number;
}

export interface PavedaPackManifest {
	schemaVersion: "1.0.0";
	generatedBy: "paveda pack build";
	compatibility: {
		packMajor: 1;
		pavedaMinVersion: "0.1.0";
	};
	entries: PackEntry[];
}

export interface BuildPackResult {
	ok: true;
	path: string;
	manifest: PavedaPackManifest;
	checksums: Record<string, string>;
	byteLength: number;
}

export interface InspectPackResult {
	ok: boolean;
	manifest: PavedaPackManifest | null;
	checksums: Record<string, string>;
	entries: PackEntry[];
	errors: string[];
}

export interface VerifyPackResult {
	ok: boolean;
	errors: string[];
	manifest: PavedaPackManifest | null;
	checkedFiles: number;
}

export interface PackInstallChange {
	packPath: string;
	projectPath: string;
	action: "create" | "update" | "unchanged";
	sha256: string;
	currentSha256: string | null;
}

export interface InstallPackResult {
	ok: boolean;
	dryRun: boolean;
	changes: PackInstallChange[];
	errors: string[];
}

interface PackFile {
	path: string;
	content: Buffer;
	kind: string;
}

interface ParsedPack {
	files: Map<string, Buffer>;
}

export function buildPack(options: BuildPackOptions): BuildPackResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const packFiles = collectPackFiles(cwd);
	const entries = packFiles.map((file) => ({
		path: file.path,
		kind: file.kind,
		sha256: sha256(file.content),
		byteLength: file.content.byteLength,
	}));
	const manifest: PavedaPackManifest = {
		schemaVersion: "1.0.0",
		generatedBy: "paveda pack build",
		compatibility: {
			packMajor: 1,
			pavedaMinVersion: "0.1.0",
		},
		entries,
	};
	const manifestFile = {
		path: "paveda-pack.json",
		content: jsonBuffer(manifest),
		kind: "manifest",
	};
	const checksums = Object.fromEntries([
		[manifestFile.path, sha256(manifestFile.content)],
		...packFiles.map((file) => [file.path, sha256(file.content)] as const),
	]);
	const checksumFile = {
		path: "checksums.json",
		content: jsonBuffer(checksums),
		kind: "checksums",
	};
	const archive = createTarGz([manifestFile, ...packFiles, checksumFile]);
	const outPath = resolve(options.out);
	assertWritePathIsSafe(outPath);
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, archive);
	return {
		ok: true,
		path: outPath,
		manifest,
		checksums,
		byteLength: archive.byteLength,
	};
}

export function inspectPack(options: InspectPackOptions): InspectPackResult {
	const parsed = readPack(options.path);
	const manifest = parseManifest(parsed.files.get("paveda-pack.json"));
	const checksums = parseChecksums(parsed.files.get("checksums.json"));
	const errors = validatePack(parsed, manifest, checksums);
	return {
		ok: errors.length === 0,
		manifest,
		checksums,
		entries: manifest?.entries ?? [],
		errors,
	};
}

export function verifyPack(options: VerifyPackOptions): VerifyPackResult {
	const inspected = inspectPack(options);
	return {
		ok: inspected.ok,
		errors: inspected.errors,
		manifest: inspected.manifest,
		checkedFiles: Object.keys(inspected.checksums).length,
	};
}

export function installPack(options: InstallPackOptions): InstallPackResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const parsed = readPack(options.path);
	const manifest = parseManifest(parsed.files.get("paveda-pack.json"));
	const checksums = parseChecksums(parsed.files.get("checksums.json"));
	const errors = validatePack(parsed, manifest, checksums);
	if (!manifest) {
		return { ok: false, dryRun: !options.write, changes: [], errors };
	}
	const changes = manifest.entries.map((entry) => {
		const projectPath = packPathToProjectPath(cwd, entry.path);
		const current = existsSync(projectPath) ? readFileSync(projectPath) : null;
		const currentSha256 = current ? sha256(current) : null;
		const action: PackInstallChange["action"] =
			currentSha256 === entry.sha256 ? "unchanged" : currentSha256 ? "update" : "create";
		return {
			packPath: entry.path,
			projectPath,
			action,
			sha256: entry.sha256,
			currentSha256,
		};
	});
	if (errors.length > 0) {
		return { ok: false, dryRun: !options.write, changes, errors };
	}
	if (options.write) {
		for (const change of changes) {
			if (change.action === "unchanged") {
				continue;
			}
			const content = parsed.files.get(change.packPath);
			if (!content) {
				throw new Error(`Pack entry missing content: ${change.packPath}`);
			}
			assertWritePathIsSafe(change.projectPath);
			mkdirSync(dirname(change.projectPath), { recursive: true });
			writeTextFileSafely(change.projectPath, content.toString("utf8"));
		}
	}
	return {
		ok: true,
		dryRun: !options.write,
		changes,
		errors: [],
	};
}

function collectPackFiles(cwd: string): PackFile[] {
	const pavedaRoot = join(cwd, ".paveda");
	const files: PackFile[] = [
		readRequiredFile(join(pavedaRoot, "contract.json"), "contracts/contract.json", "contract"),
		...readDirectoryFiles(join(pavedaRoot, "profiles"), "contracts/profiles", "profile"),
		...readDirectoryFiles(join(pavedaRoot, "hosts"), "hosts", "host"),
		...readOptionalFile(
			join(pavedaRoot, "evidence-policy.json"),
			"evidence-providers/evidence-policy.json",
			"evidence-provider-policy",
		),
		...readOptionalFile(
			join(pavedaRoot, "test-policy.json"),
			"evidence-providers/test-policy.json",
			"evidence-provider-policy",
		),
		...readOptionalFile(
			join(pavedaRoot, "learning", "patterns.json"),
			"learning/patterns.json",
			"learning",
		),
		...readOptionalFile(
			join(pavedaRoot, "learning", "shared-candidates.json"),
			"learning/shared-candidates.json",
			"learning",
		),
		...readDirectoryFiles(join(pavedaRoot, "risk-rules"), "risk-rules", "risk-rule"),
	];
	if (!files.some((file) => file.path.startsWith("contracts/profiles/"))) {
		throw new Error("Pack build requires .paveda/profiles/*.json");
	}
	if (!files.some((file) => file.path.startsWith("hosts/"))) {
		throw new Error("Pack build requires .paveda/hosts/*.json");
	}
	return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readRequiredFile(sourcePath: string, packPath: string, kind: string): PackFile {
	if (!existsSync(sourcePath)) {
		throw new Error(`Pack build requires ${sourcePath}`);
	}
	return {
		path: packPath,
		content: readFileSync(sourcePath),
		kind,
	};
}

function readOptionalFile(sourcePath: string, packPath: string, kind: string): PackFile[] {
	return existsSync(sourcePath) ? [readRequiredFile(sourcePath, packPath, kind)] : [];
}

function readDirectoryFiles(sourceRoot: string, packRoot: string, kind: string): PackFile[] {
	if (!existsSync(sourceRoot)) {
		return [];
	}
	const files: PackFile[] = [];
	for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
		const sourcePath = join(sourceRoot, entry.name);
		if (entry.isDirectory()) {
			files.push(...readDirectoryFiles(sourcePath, join(packRoot, entry.name), kind));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".json")) {
			continue;
		}
		files.push({
			path: join(packRoot, relative(sourceRoot, sourcePath)).replaceAll("\\", "/"),
			content: readFileSync(sourcePath),
			kind,
		});
	}
	return files;
}

function packPathToProjectPath(cwd: string, packPath: string): string {
	if (packPath === "contracts/contract.json") {
		return join(cwd, ".paveda", "contract.json");
	}
	if (packPath.startsWith("contracts/profiles/")) {
		return join(cwd, ".paveda", "profiles", packPath.slice("contracts/profiles/".length));
	}
	if (packPath.startsWith("hosts/")) {
		return join(cwd, ".paveda", "hosts", packPath.slice("hosts/".length));
	}
	if (packPath.startsWith("learning/")) {
		return join(cwd, ".paveda", "learning", packPath.slice("learning/".length));
	}
	if (packPath === "evidence-providers/evidence-policy.json") {
		return join(cwd, ".paveda", "evidence-policy.json");
	}
	if (packPath === "evidence-providers/test-policy.json") {
		return join(cwd, ".paveda", "test-policy.json");
	}
	if (packPath.startsWith("risk-rules/")) {
		return join(cwd, ".paveda", "risk-rules", packPath.slice("risk-rules/".length));
	}
	throw new Error(`Unsupported pack install path: ${packPath}`);
}

function validatePack(
	parsed: ParsedPack,
	manifest: PavedaPackManifest | null,
	checksums: Record<string, string>,
): string[] {
	const errors: string[] = [];
	if (!manifest) {
		errors.push("missing or invalid paveda-pack.json");
	}
	if (!parsed.files.has("checksums.json")) {
		errors.push("missing checksums.json");
	}
	if (manifest?.schemaVersion && Number(manifest.schemaVersion.split(".")[0]) !== 1) {
		errors.push(`unsupported pack major version: ${manifest.schemaVersion}`);
	}
	for (const [path, expected] of Object.entries(checksums)) {
		const content = parsed.files.get(path);
		if (!content) {
			errors.push(`checksum entry missing file: ${path}`);
			continue;
		}
		const actual = sha256(content);
		if (actual !== expected) {
			errors.push(`checksum mismatch for ${path}`);
		}
	}
	for (const entry of manifest?.entries ?? []) {
		const content = parsed.files.get(entry.path);
		if (!content) {
			errors.push(`manifest entry missing file: ${entry.path}`);
			continue;
		}
		if (sha256(content) !== entry.sha256) {
			errors.push(`manifest checksum mismatch for ${entry.path}`);
		}
		if (content.byteLength !== entry.byteLength) {
			errors.push(`manifest size mismatch for ${entry.path}`);
		}
	}
	return errors;
}

function parseManifest(content: Buffer | undefined): PavedaPackManifest | null {
	if (!content) {
		return null;
	}
	const parsed = JSON.parse(content.toString("utf8")) as Partial<PavedaPackManifest>;
	if (
		parsed.schemaVersion !== "1.0.0" ||
		parsed.generatedBy !== "paveda pack build" ||
		!Array.isArray(parsed.entries)
	) {
		return null;
	}
	return {
		schemaVersion: "1.0.0",
		generatedBy: "paveda pack build",
		compatibility: {
			packMajor: 1,
			pavedaMinVersion: "0.1.0",
		},
		entries: parsed.entries.filter(isPackEntry),
	};
}

function parseChecksums(content: Buffer | undefined): Record<string, string> {
	if (!content) {
		return {};
	}
	const parsed = JSON.parse(content.toString("utf8")) as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string] =>
				typeof entry[0] === "string" && typeof entry[1] === "string",
		),
	);
}

function isPackEntry(value: unknown): value is PackEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as PackEntry).path === "string" &&
		typeof (value as PackEntry).kind === "string" &&
		typeof (value as PackEntry).sha256 === "string" &&
		typeof (value as PackEntry).byteLength === "number"
	);
}

function readPack(path: string): ParsedPack {
	const archive = gunzipSync(readFileSync(path));
	const files = new Map<string, Buffer>();
	let offset = 0;
	while (offset + 512 <= archive.byteLength) {
		const header = archive.subarray(offset, offset + 512);
		offset += 512;
		if (header.every((byte) => byte === 0)) {
			break;
		}
		const name = readTarString(header, 0, 100);
		const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
		const typeflag = readTarString(header, 156, 1);
		const content = archive.subarray(offset, offset + size);
		offset += size + tarPadding(size);
		if (typeflag === "0" || typeflag === "") {
			files.set(name, Buffer.from(content));
		}
	}
	return { files };
}

function createTarGz(files: readonly PackFile[]): Buffer {
	const chunks: Buffer[] = [];
	for (const file of files) {
		chunks.push(tarHeader(file.path, file.content.byteLength));
		chunks.push(file.content);
		const padding = tarPadding(file.content.byteLength);
		if (padding > 0) {
			chunks.push(Buffer.alloc(padding));
		}
	}
	chunks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(chunks));
}

function tarHeader(path: string, size: number): Buffer {
	if (Buffer.byteLength(path) > 100) {
		throw new Error(`Pack path is too long for portable tar: ${path}`);
	}
	const header = Buffer.alloc(512);
	writeTarString(header, path, 0, 100);
	writeTarOctal(header, 0o644, 100, 8);
	writeTarOctal(header, 0, 108, 8);
	writeTarOctal(header, 0, 116, 8);
	writeTarOctal(header, size, 124, 12);
	writeTarOctal(header, 0, 136, 12);
	header.fill(0x20, 148, 156);
	writeTarString(header, "0", 156, 1);
	writeTarString(header, "ustar", 257, 6);
	writeTarString(header, "00", 263, 2);
	let checksum = 0;
	for (const byte of header) {
		checksum += byte;
	}
	writeTarOctal(header, checksum, 148, 8);
	return header;
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
	buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), "utf8");
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
	const encoded = value
		.toString(8)
		.padStart(length - 1, "0")
		.slice(-(length - 1));
	buffer.write(`${encoded}\0`, offset, length, "ascii");
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
	const raw = buffer.subarray(offset, offset + length);
	const nul = raw.indexOf(0);
	return raw.subarray(0, nul === -1 ? raw.byteLength : nul).toString("utf8");
}

function tarPadding(size: number): number {
	return (512 - (size % 512)) % 512;
}

function jsonBuffer(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}
