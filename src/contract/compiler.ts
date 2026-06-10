import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import { parseDocument } from "yaml";

export type ContractCompileSeverity = "error" | "warning";
export type ContractCompileOutputKind = "contract" | "profile" | "host";
export type ContractDiffSourceState = "clean" | "missing" | "drifted";

export interface ContractCompileDiagnostic {
	path: string;
	code: string;
	severity: ContractCompileSeverity;
	message: string;
}

export interface ContractCompileOutput {
	kind: ContractCompileOutputKind;
	sourcePath: string;
	outputPath: string;
	sourceSha256: string;
	compiledSha256: string;
	written: boolean;
}

export interface ContractCompileResult {
	cwd: string;
	sourceRoot: string;
	ok: boolean;
	written: boolean;
	sourceSha256: string | null;
	compiledSha256: string | null;
	diagnostics: ContractCompileDiagnostic[];
	outputs: ContractCompileOutput[];
}

export interface ContractCompileOptions {
	cwd?: string;
	write?: boolean;
}

export interface ContractDiffSourceEntry {
	kind: ContractCompileOutputKind;
	sourcePath: string;
	outputPath: string;
	state: ContractDiffSourceState;
	expectedSha256: string;
	currentSha256: string | null;
}

export interface ContractDiffSourceResult {
	cwd: string;
	sourceRoot: string;
	ok: boolean;
	compile: ContractCompileResult;
	entries: ContractDiffSourceEntry[];
}

interface SourceDocument {
	kind: ContractCompileOutputKind;
	sourcePath: string;
	outputPath: string;
	value: unknown;
	sourceSha256: string;
	compiled: string;
	compiledSha256: string;
}

interface ContractValidators {
	universalContract: ValidateFunction;
	profileManifest: ValidateFunction;
	hostDeclaration: ValidateFunction;
}

const SOURCE_EXTENSIONS = [".yaml", ".yml", ".json"];

export function compileContractSource(options: ContractCompileOptions = {}): ContractCompileResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const sourceRoot = join(cwd, ".paveda", "source");
	const diagnostics: ContractCompileDiagnostic[] = [];
	const documents = loadSourceDocuments(cwd, sourceRoot, diagnostics);

	if (documents.length > 0) {
		validateSourceDocuments(documents, diagnostics);
	}

	const ok = diagnostics.every((diagnostic) => diagnostic.severity !== "error");
	if (ok && options.write) {
		for (const document of documents) {
			mkdirSync(dirname(document.outputPath), { recursive: true });
			writeFileSync(document.outputPath, document.compiled);
		}
		writeCompilerMetadata(cwd, documents);
	}

	return {
		cwd,
		sourceRoot,
		ok,
		written: Boolean(options.write) && ok,
		sourceSha256: documents.length > 0 ? combinedHash(cwd, documents, "source") : null,
		compiledSha256: documents.length > 0 ? combinedHash(cwd, documents, "compiled") : null,
		diagnostics,
		outputs: documents.map((document) => ({
			kind: document.kind,
			sourcePath: projectPath(cwd, document.sourcePath),
			outputPath: projectPath(cwd, document.outputPath),
			sourceSha256: document.sourceSha256,
			compiledSha256: document.compiledSha256,
			written: Boolean(options.write) && ok,
		})),
	};
}

export function diffContractSource(options: ContractCompileOptions = {}): ContractDiffSourceResult {
	const compile = compileContractSource({ ...options, write: false });
	const entries = compile.outputs.map((output) => {
		const absoluteOutputPath = join(compile.cwd, output.outputPath);
		const currentSha256 = existsSync(absoluteOutputPath) ? hashFile(absoluteOutputPath) : null;
		const state: ContractDiffSourceState =
			currentSha256 === null
				? "missing"
				: currentSha256 === output.compiledSha256
					? "clean"
					: "drifted";
		return {
			kind: output.kind,
			sourcePath: output.sourcePath,
			outputPath: output.outputPath,
			state,
			expectedSha256: output.compiledSha256,
			currentSha256,
		};
	});

	return {
		cwd: compile.cwd,
		sourceRoot: compile.sourceRoot,
		ok: compile.ok && entries.every((entry) => entry.state === "clean"),
		compile,
		entries,
	};
}

function loadSourceDocuments(
	cwd: string,
	sourceRoot: string,
	diagnostics: ContractCompileDiagnostic[],
): SourceDocument[] {
	if (!existsSync(sourceRoot)) {
		diagnostics.push({
			path: projectPath(cwd, sourceRoot),
			code: "source.missing",
			severity: "error",
			message: "Missing .paveda/source contract source directory.",
		});
		return [];
	}

	const documents: SourceDocument[] = [];
	for (const document of loadOne(
		cwd,
		sourceRoot,
		"contract",
		join(cwd, ".paveda", "contract.json"),
		diagnostics,
	)) {
		documents.push({ ...document, kind: "contract" });
	}
	for (const sourcePath of listSourceFiles(join(sourceRoot, "profiles"))) {
		const parsed = parseSourceFile(cwd, sourcePath, diagnostics);
		if (parsed) {
			const profileName =
				readStringField(parsed.value, "profile") ?? basenameWithoutExtension(sourcePath);
			documents.push({
				kind: "profile",
				sourcePath,
				outputPath: join(cwd, ".paveda", "profiles", `${profileName}.json`),
				...parsed,
			});
		}
	}
	for (const sourcePath of listSourceFiles(join(sourceRoot, "hosts"))) {
		const parsed = parseSourceFile(cwd, sourcePath, diagnostics);
		if (parsed) {
			const hostName =
				readStringField(parsed.value, "host") ?? basenameWithoutExtension(sourcePath);
			documents.push({
				kind: "host",
				sourcePath,
				outputPath: join(cwd, ".paveda", "hosts", `${hostName}.json`),
				...parsed,
			});
		}
	}
	return documents.sort((left, right) => left.outputPath.localeCompare(right.outputPath));
}

function loadOne(
	cwd: string,
	sourceRoot: string,
	name: string,
	outputPath: string,
	diagnostics: ContractCompileDiagnostic[],
): Array<Omit<SourceDocument, "kind">> {
	const sourcePath = findSourceFile(sourceRoot, name);
	if (!sourcePath) {
		diagnostics.push({
			path: projectPath(cwd, join(sourceRoot, `${name}.yaml`)),
			code: "source.file_missing",
			severity: "error",
			message: `Missing source file for ${name}.`,
		});
		return [];
	}
	const parsed = parseSourceFile(cwd, sourcePath, diagnostics);
	return parsed ? [{ sourcePath, outputPath, ...parsed }] : [];
}

function parseSourceFile(
	cwd: string,
	sourcePath: string,
	diagnostics: ContractCompileDiagnostic[],
): {
	value: unknown;
	sourceSha256: string;
	compiled: string;
	compiledSha256: string;
} | null {
	const raw = readFileSync(sourcePath, "utf8");
	const sourceSha256 = hashText(raw);
	try {
		const value =
			extname(sourcePath) === ".json"
				? JSON.parse(raw)
				: parseYamlSource(cwd, sourcePath, raw, diagnostics);
		if (value === null) {
			return null;
		}
		const compiled = `${stableStringify(value)}\n`;
		return {
			value,
			sourceSha256,
			compiled,
			compiledSha256: hashText(compiled),
		};
	} catch (error) {
		diagnostics.push({
			path: projectPath(cwd, sourcePath),
			code: "source.parse",
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function parseYamlSource(
	cwd: string,
	sourcePath: string,
	raw: string,
	diagnostics: ContractCompileDiagnostic[],
): unknown | null {
	const document = parseDocument(raw, { prettyErrors: false });
	if (document.errors.length > 0) {
		for (const error of document.errors) {
			diagnostics.push({
				path: projectPath(cwd, sourcePath),
				code: "source.yaml",
				severity: "error",
				message: error.message,
			});
		}
		return null;
	}
	return document.toJSON();
}

function validateSourceDocuments(
	documents: readonly SourceDocument[],
	diagnostics: ContractCompileDiagnostic[],
): void {
	const validators = buildValidators();
	const contracts = documents.filter((document) => document.kind === "contract");
	if (contracts.length !== 1) {
		diagnostics.push({
			path: ".paveda/source/contract.yaml",
			code: "source.contract_count",
			severity: "error",
			message: "Exactly one contract source is required.",
		});
	}
	for (const document of documents) {
		const validator =
			document.kind === "contract"
				? validators.universalContract
				: document.kind === "profile"
					? validators.profileManifest
					: validators.hostDeclaration;
		if (!validator(document.value)) {
			for (const error of validator.errors ?? []) {
				diagnostics.push({
					path: document.sourcePath,
					code: "schema.invalid",
					severity: "error",
					message: `${error.instancePath || "/"} ${error.message ?? "schema validation failed"}`,
				});
			}
		}
	}

	const contract = contracts[0]?.value;
	if (!isRecord(contract)) {
		return;
	}
	validatePhaseGraph(contract, diagnostics);
	validateCapabilityReferences(contract, documents, diagnostics);
}

function validatePhaseGraph(
	contract: Record<string, unknown>,
	diagnostics: ContractCompileDiagnostic[],
): void {
	const phaseGraph = asRecord(contract.phaseGraph);
	const nodes = Array.isArray(phaseGraph?.nodes) ? phaseGraph.nodes.filter(isRecord) : [];
	const edges = Array.isArray(phaseGraph?.edges) ? phaseGraph.edges.filter(isRecord) : [];
	const nodeIds = new Set(nodes.map((node) => readStringField(node, "id")).filter(isString));
	const adjacency = new Map<string, string[]>();

	for (const edge of edges) {
		const from = readStringField(edge, "from");
		const to = readStringField(edge, "to");
		if (!from || !to) {
			continue;
		}
		if (!nodeIds.has(from) || !nodeIds.has(to)) {
			diagnostics.push({
				path: ".paveda/source/contract.yaml",
				code: "semantic.phase_edge_reference",
				severity: "error",
				message: `Phase edge references unknown node: ${from} -> ${to}.`,
			});
		}
		adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (node: string): boolean => {
		if (visiting.has(node)) {
			return true;
		}
		if (visited.has(node)) {
			return false;
		}
		visiting.add(node);
		for (const next of adjacency.get(node) ?? []) {
			if (visit(next)) {
				return true;
			}
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	if ([...nodeIds].some((node) => visit(node))) {
		diagnostics.push({
			path: ".paveda/source/contract.yaml",
			code: "semantic.phase_graph_cycle",
			severity: "error",
			message: "Phase graph must be acyclic.",
		});
	}
}

function validateCapabilityReferences(
	contract: Record<string, unknown>,
	documents: readonly SourceDocument[],
	diagnostics: ContractCompileDiagnostic[],
): void {
	const capabilities = new Set(
		(Array.isArray(contract.capabilityRequirements) ? contract.capabilityRequirements : [])
			.filter(isRecord)
			.map((capability) => readStringField(capability, "id"))
			.filter(isString),
	);
	const checkCapability = (sourcePath: string, owner: string, capability: unknown): void => {
		if (typeof capability === "string" && !capabilities.has(capability)) {
			diagnostics.push({
				path: sourcePath,
				code: "semantic.capability_reference",
				severity: "error",
				message: `${owner} references unknown capability ${capability}.`,
			});
		}
	};

	for (const gate of (Array.isArray(contract.gates) ? contract.gates : []).filter(isRecord)) {
		checkCapability(
			".paveda/source/contract.yaml",
			`gate ${readStringField(gate, "id") ?? "<unknown>"}`,
			gate.capability,
		);
	}
	for (const document of documents) {
		if (document.kind === "profile") {
			const profile = asRecord(document.value);
			const gates = Array.isArray(profile?.requiredGates) ? profile.requiredGates : [];
			for (const gate of gates.filter(isRecord)) {
				checkCapability(
					document.sourcePath,
					`profile gate ${readStringField(gate, "id") ?? "<unknown>"}`,
					gate.capability,
				);
			}
		}
		if (document.kind === "host") {
			const host = asRecord(document.value);
			const capabilitiesList = Array.isArray(host?.capabilities) ? host.capabilities : [];
			for (const capability of capabilitiesList.filter(isRecord)) {
				checkCapability(
					document.sourcePath,
					`host capability ${readStringField(capability, "id") ?? "<unknown>"}`,
					capability.id,
				);
			}
		}
	}
}

function writeCompilerMetadata(cwd: string, documents: readonly SourceDocument[]): void {
	const indexPath = join(cwd, ".paveda", "projections", "index.json");
	if (!existsSync(indexPath)) {
		return;
	}
	const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
	index.compiler = {
		sourceSha256: combinedHash(cwd, documents, "source"),
		compiledSha256: combinedHash(cwd, documents, "compiled"),
		outputs: documents.map((document) => ({
			kind: document.kind,
			sourcePath: projectPath(cwd, document.sourcePath),
			outputPath: projectPath(cwd, document.outputPath),
			sourceSha256: document.sourceSha256,
			compiledSha256: document.compiledSha256,
		})),
		generatedAt: new Date().toISOString(),
	};
	writeFileSync(indexPath, `${stableStringify(index)}\n`);
}

function buildValidators(): ContractValidators {
	const contractSchema = readJson<AnySchema>(
		join(packageHarnessRoot(), "contracts", "schemas", "contract.schema.json"),
	);
	const capabilitiesSchema = readJson<AnySchema>(
		join(packageHarnessRoot(), "contracts", "schemas", "capabilities.schema.json"),
	);
	const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
	ajv.addSchema(capabilitiesSchema);
	ajv.addSchema(contractSchema);

	return {
		universalContract: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/universalContract",
		),
		profileManifest: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/profileManifest",
		),
		hostDeclaration: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/hostDeclaration",
		),
	};
}

function requiredSchema(ajv: Ajv, id: string): ValidateFunction {
	const schema = ajv.getSchema(id);
	if (!schema) {
		throw new Error(`Missing compiled schema: ${id}`);
	}
	return schema;
}

function findSourceFile(directory: string, name: string): string | null {
	for (const extension of SOURCE_EXTENSIONS) {
		const candidate = join(directory, `${name}${extension}`);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

function listSourceFiles(directory: string): string[] {
	if (!existsSync(directory)) {
		return [];
	}
	return readdirSync(directory)
		.filter((entry) => SOURCE_EXTENSIONS.includes(extname(entry)))
		.sort()
		.map((entry) => join(directory, entry));
}

function basenameWithoutExtension(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1, path.length - extname(path).length);
}

function combinedHash(
	cwd: string,
	documents: readonly SourceDocument[],
	mode: "source" | "compiled",
): string {
	const lines = documents.map((document) =>
		[
			projectPath(cwd, document.outputPath),
			mode === "source" ? document.sourceSha256 : document.compiledSha256,
		].join(":"),
	);
	return hashText(`${lines.sort().join("\n")}\n`);
}

function hashFile(path: string): string {
	return hashText(readFileSync(path, "utf8"));
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function projectPath(cwd: string, path: string): string {
	return relative(cwd, path).replaceAll("\\", "/") || ".";
}

function packageHarnessRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "harness");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([left], [right]) => left.localeCompare(right));
		return `{${entries
			.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function readStringField(value: unknown, field: string): string | null {
	const record = asRecord(value);
	const fieldValue = record?.[field];
	return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
