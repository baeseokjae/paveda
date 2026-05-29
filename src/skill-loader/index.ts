import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

export type SkillScope = "project" | "user" | "builtin";

export interface SkillTrigger {
	paths?: string[];
	keywords?: string[];
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	allowedTools?: string[];
	argumentHint?: string;
	disableModelInvocation?: boolean;
	router?: string | boolean;
	trigger?: SkillTrigger;
	ambiguityRequired?: number;
	[key: string]: unknown;
}

export interface LoadedSkill {
	name: string;
	scope: SkillScope;
	path: string;
	root: string;
	relativePath: string;
	frontmatter: SkillFrontmatter;
	body: string;
}

export interface SkillStatusEntry {
	name: string;
	selected: SkillStatusCandidate;
	shadowed: SkillStatusCandidate[];
	routerEnabled: boolean;
	issues: SkillStatusIssue[];
}

export interface SkillStatusCandidate {
	scope: SkillScope;
	path: string;
	relativePath: string;
	description?: string;
	model?: string;
	router?: string | boolean;
	ambiguityRequired?: number;
}

export interface SkillStatusIssue {
	code: string;
	message: string;
	recommendation: string;
}

export interface SkillRoot {
	scope: SkillScope;
	path: string;
}

export interface LoadSkillsOptions {
	cwd?: string;
	projectRoots?: string[];
	userRoots?: string[];
	builtinRoots?: string[];
}

export interface InstallBuiltinSkillOptions extends LoadSkillsOptions {
	name: string;
	write?: boolean;
	force?: boolean;
	targetRoot?: string;
}

export interface InstallBuiltinSkillResult {
	name: string;
	sourcePath: string;
	targetPath: string;
	written: boolean;
	overwritten: boolean;
}

export interface EnableSkillRouterOptions extends LoadSkillsOptions {
	name: string;
	write?: boolean;
	ambiguityRequired?: number;
}

export interface EnableSkillRouterResult {
	name: string;
	path: string;
	scope: SkillScope;
	written: boolean;
	changed: boolean;
	routerEnabled: boolean;
	ambiguityRequired: number;
	preview: string;
}

interface ParsedSkillDocument {
	frontmatter: SkillFrontmatter;
	body: string;
}

interface HarnessManifest {
	skills?: Array<{ name?: string; path?: string }>;
}

const SKILL_FILENAME = "SKILL.md";
const PROJECT_SKILL_DIRS = [".harness/skills", ".claude/skills"] as const;
const USER_SKILL_DIRS = [".harness/skills"] as const;

export function loadSkills(options: LoadSkillsOptions = {}): LoadedSkill[] {
	const roots = resolveSkillRoots(options);
	const byName = new Map<string, LoadedSkill>();

	for (const root of roots) {
		for (const path of discoverSkillFilesForRoot(root)) {
			const skill = loadSkillFile(path, root);
			if (!byName.has(skill.name)) {
				byName.set(skill.name, skill);
			}
		}
	}

	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkillStatus(options: LoadSkillsOptions = {}): SkillStatusEntry[] {
	const candidates = loadSkillCandidates(options);
	const byName = new Map<string, LoadedSkill[]>();

	for (const skill of candidates) {
		const items = byName.get(skill.name) ?? [];
		items.push(skill);
		byName.set(skill.name, items);
	}

	return [...byName.entries()]
		.map(([name, items]) => {
			const [selected, ...shadowed] = items;
			if (!selected) {
				throw new Error(`Skill status entry has no selected candidate: ${name}`);
			}

			return {
				name,
				selected: toStatusCandidate(selected),
				shadowed: shadowed.map(toStatusCandidate),
				routerEnabled: isSkillRouterEnabled(selected),
				issues: collectSkillStatusIssues(selected, shadowed),
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function findSkill(skills: readonly LoadedSkill[], name: string): LoadedSkill | undefined {
	return skills.find((skill) => skill.name === name);
}

export function isSkillRouterEnabled(skill: LoadedSkill): boolean {
	return skill.frontmatter.router === "enabled" || skill.frontmatter.router === true;
}

export function installBuiltinSkill(
	options: InstallBuiltinSkillOptions,
): InstallBuiltinSkillResult {
	const cwd = options.cwd ?? process.cwd();
	const builtinSkill = findSkill(
		loadSkills({
			cwd,
			projectRoots: [],
			userRoots: [],
			builtinRoots: options.builtinRoots,
		}),
		options.name,
	);
	if (!builtinSkill) {
		throw new Error(`Unknown builtin skill: ${options.name}`);
	}

	const targetRoot = options.targetRoot
		? resolve(cwd, options.targetRoot)
		: join(cwd, ".harness", "skills");
	const targetPath = join(targetRoot, builtinSkill.name, SKILL_FILENAME);
	const exists = existsSync(targetPath);
	if (exists && !options.force) {
		throw new Error(`Skill already exists: ${targetPath}`);
	}

	if (options.write) {
		assertSkillWritePathIsSafe(targetRoot);
		assertSkillWritePathIsSafe(targetPath);
		copySkillDirectorySafely(dirname(builtinSkill.path), dirname(targetPath));
	}

	return {
		name: builtinSkill.name,
		sourcePath: builtinSkill.path,
		targetPath,
		written: Boolean(options.write),
		overwritten: exists && Boolean(options.write),
	};
}

export function enableSkillRouter(options: EnableSkillRouterOptions): EnableSkillRouterResult {
	if (options.name !== "do") {
		throw new Error("PAL Router metadata is only supported for /do");
	}

	const requestedAmbiguityRequired = options.ambiguityRequired ?? 0.2;
	const skill = findSkill(loadSkills(options), options.name);
	if (!skill) {
		throw new Error(`Unknown skill: ${options.name}`);
	}

	const raw = readFileSync(skill.path, "utf8");
	const next = upsertSkillRouterFrontmatter(raw, requestedAmbiguityRequired, {
		preserveExistingAmbiguity: options.ambiguityRequired === undefined,
	});
	const changed = next !== raw;
	if (options.write && changed) {
		assertSkillWritePathIsSafe(skill.path);
		writeFileSync(skill.path, next);
	}
	const ambiguityRequired =
		parseSkillDocument(next).frontmatter.ambiguityRequired ?? requestedAmbiguityRequired;

	return {
		name: skill.name,
		path: skill.path,
		scope: skill.scope,
		written: Boolean(options.write && changed),
		changed,
		routerEnabled: true,
		ambiguityRequired,
		preview: extractFrontmatterPreview(next),
	};
}

export function resolveSkillRoots(options: LoadSkillsOptions = {}): SkillRoot[] {
	const cwd = options.cwd ?? process.cwd();
	const projectRoots = options.projectRoots ?? PROJECT_SKILL_DIRS.map((path) => join(cwd, path));
	const userRoots = options.userRoots ?? USER_SKILL_DIRS.map((path) => join(homedir(), path));
	const builtinRoots = options.builtinRoots ?? [
		join(dirname(fileURLToPath(import.meta.url)), "../../assets/harness/skills"),
	];

	return [
		...projectRoots.map((path) => ({ scope: "project" as const, path })),
		...userRoots.map((path) => ({ scope: "user" as const, path })),
		...builtinRoots.map((path) => ({ scope: "builtin" as const, path })),
	];
}

function loadSkillCandidates(options: LoadSkillsOptions = {}): LoadedSkill[] {
	const roots = resolveSkillRoots(options);
	const skills: LoadedSkill[] = [];

	for (const root of roots) {
		for (const path of discoverSkillFilesForRoot(root)) {
			skills.push(loadSkillFile(path, root));
		}
	}

	return skills;
}

function toStatusCandidate(skill: LoadedSkill): SkillStatusCandidate {
	return {
		scope: skill.scope,
		path: skill.path,
		relativePath: skill.relativePath,
		description: skill.frontmatter.description,
		model: skill.frontmatter.model,
		router: skill.frontmatter.router,
		ambiguityRequired: skill.frontmatter.ambiguityRequired,
	};
}

function collectSkillStatusIssues(
	selected: LoadedSkill,
	shadowed: readonly LoadedSkill[],
): SkillStatusIssue[] {
	const issues: SkillStatusIssue[] = [];
	const routerEnabledCandidate = shadowed.find(isSkillRouterEnabled);
	if (!isSkillRouterEnabled(selected) && routerEnabledCandidate) {
		issues.push({
			code: "router-enabled-skill-shadowed",
			message: `${selected.name} is selected from ${selected.scope}, but a router-enabled ${routerEnabledCandidate.scope} candidate is shadowed.`,
			recommendation: `Add "router: enabled" to ${selected.path} or install the builtin harness skill into a higher-priority skill root.`,
		});
	}

	return issues;
}

function upsertFrontmatterValue(
	frontmatter: string,
	key: string,
	value: string,
	options: { onlyIfMissing?: boolean } = {},
): string {
	const lines = frontmatter.split("\n");
	const index = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegExp(key)}:\\s*`)));
	if (index === -1) {
		return [...lines, `${key}: ${value}`].join("\n");
	}

	if (options.onlyIfMissing) {
		return frontmatter;
	}

	lines[index] = `${key}: ${value}`;
	return lines.join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadSkillFile(path: string, root: SkillRoot): LoadedSkill {
	const raw = readFileSync(path, "utf8");
	const parsed = parseSkillDocument(raw);
	const directoryName = dirname(relative(root.path, path));
	const fallbackName =
		directoryName === "." ? dirname(path).split("/").at(-1) : directoryName.split("/").at(-1);
	const name = parsed.frontmatter.name ?? fallbackName;

	if (!name) {
		throw new Error(`Skill file is missing frontmatter name: ${path}`);
	}

	return {
		name,
		scope: root.scope,
		path,
		root: root.path,
		relativePath: relative(root.path, path),
		frontmatter: parsed.frontmatter,
		body: parsed.body,
	};
}

export function parseSkillDocument(raw: string): ParsedSkillDocument {
	if (!raw.startsWith("---\n")) {
		return {
			frontmatter: {},
			body: raw,
		};
	}

	const end = raw.indexOf("\n---", 4);
	if (end === -1) {
		throw new Error("Unterminated SKILL.md frontmatter");
	}

	const yaml = raw.slice(4, end);
	const body = raw.slice(end + 4).replace(/^(?:\r?\n)+/, "");

	return {
		frontmatter: parseFrontmatter(yaml),
		body,
	};
}

export function upsertSkillRouterFrontmatter(
	raw: string,
	ambiguityRequired = 0.2,
	options: { preserveExistingAmbiguity?: boolean } = {},
): string {
	if (!raw.startsWith("---\n")) {
		return [
			"---",
			"router: enabled",
			`ambiguity-required: ${ambiguityRequired}`,
			"---",
			"",
			raw,
		].join("\n");
	}

	const end = raw.indexOf("\n---", 4);
	if (end === -1) {
		throw new Error("Unterminated SKILL.md frontmatter");
	}

	const frontmatter = raw.slice(4, end);
	const rest = raw.slice(end + 4);
	const nextFrontmatter = upsertFrontmatterValue(
		upsertFrontmatterValue(frontmatter, "router", "enabled"),
		"ambiguity-required",
		String(ambiguityRequired),
		{ onlyIfMissing: options.preserveExistingAmbiguity },
	);

	return `---\n${nextFrontmatter}\n---${rest}`;
}

function extractFrontmatterPreview(raw: string): string {
	if (!raw.startsWith("---\n")) {
		return raw.split("\n").slice(0, 8).join("\n");
	}

	const end = raw.indexOf("\n---", 4);
	if (end === -1) {
		return raw;
	}

	return `${raw.slice(0, end)}\n---`;
}

export function parseFrontmatter(raw: string): SkillFrontmatter {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const result: Record<string, unknown> = {};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || line.trim() === "" || line.trimStart().startsWith("#")) {
			continue;
		}

		if (line.startsWith(" ") || line.startsWith("\t")) {
			continue;
		}

		const match = line.match(/^([^:]+):\s*(.*)$/);
		if (!match) {
			continue;
		}

		const rawKey = match[1]?.trim();
		const rawValue = match[2] ?? "";
		if (!rawKey) {
			continue;
		}

		const key = normalizeKey(rawKey);
		if (rawValue === "|") {
			const block = collectIndentedBlock(lines, index + 1);
			result[key] = block.value;
			index = block.nextIndex - 1;
			continue;
		}

		if (rawValue === "") {
			const nested = collectNestedObject(lines, index + 1);
			if (nested.keys.length > 0) {
				result[key] = nested.value;
				index = nested.nextIndex - 1;
				continue;
			}
		}

		result[key] = parseScalar(rawValue);
	}

	if (typeof result.allowedTools === "string") {
		result.allowedTools = splitCommaList(result.allowedTools);
	}

	return result as SkillFrontmatter;
}

function discoverSkillFilesForRoot(root: SkillRoot): string[] {
	if (root.scope !== "builtin") {
		return discoverSkillFiles(root.path);
	}

	const manifest = readHarnessManifest(dirname(root.path));
	if (!manifest?.skills) {
		return discoverSkillFiles(root.path);
	}

	return manifest.skills
		.flatMap((skill) => {
			const skillPath = skill.path ?? (skill.name ? `skills/${skill.name}` : undefined);
			return skillPath ? [{ name: skill.name, path: skillPath }] : [];
		})
		.map((skill) => {
			const path = join(dirname(root.path), skill.path, SKILL_FILENAME);
			if (!existsSync(path)) {
				const name = skill.name ?? path;
				throw new Error(`Harness manifest references missing skill: ${name}`);
			}
			return path;
		});
}

function readHarnessManifest(harnessRoot: string): HarnessManifest | undefined {
	const path = join(harnessRoot, "manifest.json");
	if (!existsSync(path)) {
		return undefined;
	}

	return JSON.parse(readFileSync(path, "utf8")) as HarnessManifest;
}

function discoverSkillFiles(root: string): string[] {
	if (!existsSync(root)) {
		return [];
	}

	const files: string[] = [];
	const entries = readdirSync(root, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...discoverSkillFiles(path));
			continue;
		}

		if (entry.isFile() && entry.name === SKILL_FILENAME) {
			files.push(path);
		}
	}

	return files.sort();
}

function copySkillDirectorySafely(sourceDir: string, targetDir: string): void {
	assertSkillWritePathIsSafe(targetDir);
	mkdirSync(targetDir, { recursive: true });

	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);

		if (entry.isDirectory()) {
			copySkillDirectorySafely(sourcePath, targetPath);
			continue;
		}

		if (entry.isFile()) {
			assertSkillWritePathIsSafe(targetPath);
			copyFileSync(sourcePath, targetPath);
			chmodSync(targetPath, statSync(sourcePath).mode);
		}
	}
}

function collectIndentedBlock(
	lines: string[],
	startIndex: number,
): { value: string; nextIndex: number } {
	const block: string[] = [];
	let index = startIndex;
	for (; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || line.trim() === "") {
			block.push("");
			continue;
		}
		if (!line.startsWith(" ") && !line.startsWith("\t")) {
			break;
		}
		block.push(line.replace(/^\s{2}/, ""));
	}

	return {
		value: block.join("\n").trimEnd(),
		nextIndex: index,
	};
}

function collectNestedObject(
	lines: string[],
	startIndex: number,
): { value: Record<string, unknown>; keys: string[]; nextIndex: number } {
	const value: Record<string, unknown> = {};
	const keys: string[] = [];
	let index = startIndex;

	for (; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || line.trim() === "") {
			continue;
		}
		if (!line.startsWith(" ") && !line.startsWith("\t")) {
			break;
		}

		const match = line.trim().match(/^([^:]+):\s*(.*)$/);
		if (!match) {
			continue;
		}

		const key = normalizeKey(match[1]?.trim() ?? "");
		value[key] = parseScalar(match[2] ?? "");
		keys.push(key);
	}

	return { value, keys, nextIndex: index };
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "true") {
		return true;
	}
	if (trimmed === "false") {
		return false;
	}
	if (trimmed === "null") {
		return null;
	}
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
		return Number(trimmed);
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return splitCommaList(trimmed.slice(1, -1));
	}

	return stripQuotes(trimmed);
}

function splitCommaList(value: string): string[] {
	return value
		.split(",")
		.map((item) => stripQuotes(item.trim()))
		.filter(Boolean);
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}

	return value;
}

function normalizeKey(value: string): string {
	return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function assertSkillWritePathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Skill write path");
}
