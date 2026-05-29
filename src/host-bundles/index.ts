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
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";
import {
	type LoadSkillsOptions,
	type LoadedSkill,
	findSkill,
	loadSkills,
} from "../skill-loader/index.js";

export type HostSkillBundleTarget = "harness" | "claude-code" | "codex" | "pi" | "hermes";

export interface InstallHostSkillBundleOptions extends LoadSkillsOptions {
	host: HostSkillBundleTarget | string;
	targetRoot?: string;
	skills?: string[];
	write?: boolean;
	force?: boolean;
}

export interface HostSkillBundleEntry {
	name: string;
	sourcePath: string;
	targetPath: string;
	exists: boolean;
	written: boolean;
	overwritten: boolean;
}

export interface HostInstructionFileEntry {
	sourcePath: string;
	targetPath: string;
	exists: boolean;
	written: boolean;
	overwritten: boolean;
}

export interface HostContextModuleEntry {
	name: string;
	sourcePath: string;
	targetPath: string;
	exists: boolean;
	written: boolean;
	overwritten: boolean;
}

export interface HostConfigFileEntry {
	targetPath: string;
	exists: boolean;
	written: boolean;
	overwritten: boolean;
	registered: boolean;
	requiredEntry: string;
}

export interface InstallHostSkillBundleResult {
	host: HostSkillBundleTarget;
	targetRoot: string;
	written: boolean;
	force: boolean;
	instructionFile?: HostInstructionFileEntry;
	hostConfigFile?: HostConfigFileEntry;
	contextModules: HostContextModuleEntry[];
	skills: HostSkillBundleEntry[];
}

interface HarnessManifest {
	instructions?: { path?: string };
	contextModules?: Array<{ path?: string }>;
	skills?: Array<{ name?: string }>;
}

interface HostBundleConflict {
	targetPath: string;
}

interface HostRenderPaths {
	skillRoot: string;
	contextRoot: string;
	instructionFile: string;
}

const HOST_SKILL_ROOTS: Record<HostSkillBundleTarget, string> = {
	harness: ".harness/skills",
	"claude-code": ".claude/skills",
	codex: ".codex/skills",
	pi: ".pi/skills",
	hermes: ".hermes/skills",
};

const HOST_PROJECT_DIRS: Record<HostSkillBundleTarget, string> = {
	harness: ".harness",
	"claude-code": ".claude",
	codex: ".codex",
	pi: ".pi",
	hermes: ".hermes",
};

const HOST_INSTRUCTION_FILES: Record<HostSkillBundleTarget, string> = {
	harness: ".harness/AGENTS.md",
	"claude-code": ".claude/CLAUDE.md",
	codex: "AGENTS.md",
	pi: ".pi/AGENTS.md",
	hermes: ".hermes/AGENTS.md",
};
const HERMES_CONFIG_FILE = ".hermes/config.yaml";

export const HOST_CONTEXT_MODULE_FILES = [
	"backend-patterns.md",
	"frontend-patterns.md",
	"worker-patterns.md",
	"infra-patterns.md",
] as const;
const FALLBACK_CONTEXT_MODULE_FILES = [...HOST_CONTEXT_MODULE_FILES];

const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".sh", ".txt", ".yaml", ".yml"]);
const CODEX_BRAND_COLOR = "#111827";
const MIN_CODEX_DESCRIPTION_LENGTH = 25;
const MAX_CODEX_DESCRIPTION_LENGTH = 64;
const MODEL_TIERS = ["frontier", "standard", "frugal"] as const;
type ModelTier = (typeof MODEL_TIERS)[number];

const HOST_MODEL_HINTS: Record<HostSkillBundleTarget, Record<ModelTier, string | undefined>> = {
	harness: {
		frontier: "frontier",
		standard: "standard",
		frugal: "frugal",
	},
	"claude-code": {
		frontier: "opus",
		standard: "sonnet",
		frugal: "haiku",
	},
	codex: {
		frontier: undefined,
		standard: undefined,
		frugal: undefined,
	},
	pi: {
		frontier: undefined,
		standard: undefined,
		frugal: undefined,
	},
	hermes: {
		frontier: undefined,
		standard: undefined,
		frugal: undefined,
	},
};

export function installHostSkillBundle(
	options: InstallHostSkillBundleOptions,
): InstallHostSkillBundleResult {
	const host = parseHostSkillBundleTarget(options.host);
	const cwd = options.cwd ?? process.cwd();
	const targetRoot = resolveTargetRoot(cwd, options.targetRoot, resolveHostSkillRoot(host, cwd));
	const renderPaths = resolveHostRenderPaths(host, cwd, targetRoot);
	const builtinSkills = loadSkills({
		cwd,
		projectRoots: [],
		userRoots: [],
		builtinRoots: options.builtinRoots,
	});
	const canonicalSkills = selectManifestSkills(builtinSkills);
	const selectedSkills = selectSkills(canonicalSkills, options.skills);
	const instructionFile = resolveInstructionFileEntry(
		selectedSkills,
		host,
		cwd,
		Boolean(options.write),
	);
	const hostConfigFile = resolveHostConfigFileEntry(
		host,
		cwd,
		Boolean(options.write),
		renderPaths.skillRoot,
	);
	const contextModules = resolveContextModuleEntries(
		selectedSkills,
		host,
		cwd,
		Boolean(options.write),
	);
	const entries = selectedSkills.map((skill) => {
		const targetPath = join(targetRoot, skill.name, "SKILL.md");
		const exists = existsSync(targetPath);
		return {
			name: skill.name,
			sourcePath: skill.path,
			targetPath,
			exists,
			written: Boolean(options.write),
			overwritten: exists && Boolean(options.write && options.force),
		};
	});

	if (options.write) {
		assertHostBundleTargetPathIsSafe(targetRoot);
		for (const entry of [
			...entries,
			...(instructionFile ? [instructionFile] : []),
			...(hostConfigFile ? [hostConfigFile] : []),
			...contextModules,
		]) {
			assertHostBundleTargetPathIsSafe(entry.targetPath);
		}

		const conflicts = uniqueConflicts([
			...entries.filter((entry) => entry.exists && !options.force),
			...(instructionFile?.exists && !options.force ? [instructionFile] : []),
			...contextModules.filter((entry) => entry.exists && !options.force),
			...(options.force
				? []
				: selectedSkills.flatMap((skill) =>
						collectExistingSkillTargetFiles(
							dirname(skill.path),
							join(targetRoot, skill.name),
							host,
						),
					)),
		]);
		if (conflicts.length > 0) {
			throw new Error(
				`Host skill bundle target already exists: ${conflicts
					.map((entry) => entry.targetPath)
					.join(", ")}`,
			);
		}

		mkdirSync(targetRoot, { recursive: true });
		if (instructionFile) {
			writeHostInstructionFile(
				instructionFile.sourcePath,
				instructionFile.targetPath,
				host,
				renderPaths,
			);
		}
		if (hostConfigFile) {
			writeHostConfigFile(hostConfigFile);
		}
		writeHostContextModules(contextModules, host, renderPaths);
		for (const skill of selectedSkills) {
			const skillTargetDir = join(targetRoot, skill.name);
			copyAssetDirectoryForHost(dirname(skill.path), skillTargetDir, host, renderPaths);
			writeHostGeneratedMetadata(skill, skillTargetDir, host);
		}
	}

	return {
		host,
		targetRoot,
		written: Boolean(options.write),
		force: Boolean(options.force),
		instructionFile,
		hostConfigFile,
		contextModules,
		skills: entries,
	};
}

export function parseHostSkillBundleTarget(host: string): HostSkillBundleTarget {
	if (isHostSkillBundleTarget(host)) {
		return host;
	}

	throw new Error(`Unsupported skill bundle host: ${host}`);
}

export function resolveHostSkillRoot(
	host: HostSkillBundleTarget | string,
	cwd = process.cwd(),
	targetRoot?: string,
): string {
	return resolveTargetRoot(
		cwd,
		targetRoot,
		join(cwd, HOST_SKILL_ROOTS[parseHostSkillBundleTarget(host)]),
	);
}

export function resolveHostInstructionFilePath(
	host: HostSkillBundleTarget | string,
	cwd = process.cwd(),
): string {
	return join(cwd, HOST_INSTRUCTION_FILES[parseHostSkillBundleTarget(host)]);
}

export function resolveHostContextModuleRoot(
	host: HostSkillBundleTarget | string,
	cwd = process.cwd(),
): string {
	return join(cwd, HOST_PROJECT_DIRS[parseHostSkillBundleTarget(host)], "context-modules");
}

function resolveTargetRoot(cwd: string, targetRoot: string | undefined, fallback: string): string {
	if (!targetRoot) {
		return fallback;
	}
	return resolve(cwd, targetRoot);
}

function resolveHostRenderPaths(
	host: HostSkillBundleTarget,
	cwd: string,
	targetRoot: string,
): HostRenderPaths {
	const projectDir = HOST_PROJECT_DIRS[host];
	return {
		skillRoot: formatProjectPath(cwd, targetRoot),
		contextRoot: `${projectDir}/context-modules`,
		instructionFile: HOST_INSTRUCTION_FILES[host],
	};
}

function formatProjectPath(cwd: string, targetPath: string): string {
	const relativePath = relative(cwd, targetPath);
	if (relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return toPosixPath(relativePath);
	}
	if (relativePath.length === 0) {
		return ".";
	}
	return toPosixPath(targetPath);
}

function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveCanonicalContextModuleFiles(
	harnessRoot = resolvePackagedHarnessRoot(),
): string[] {
	const manifest = readHarnessManifest(harnessRoot);
	if (!manifest?.contextModules) {
		return FALLBACK_CONTEXT_MODULE_FILES;
	}

	return manifest.contextModules
		.map((module) => module.path)
		.filter((path): path is string => Boolean(path))
		.map((path) => basename(path));
}

export function renderHostSkillText(
	input: string,
	host: HostSkillBundleTarget | string,
	paths: Partial<HostRenderPaths> = {},
): string {
	const target = parseHostSkillBundleTarget(host);
	const projectDir = HOST_PROJECT_DIRS[target];
	const skillRoot = paths.skillRoot ?? `${projectDir}/skills`;
	const contextRoot = paths.contextRoot ?? `${projectDir}/context-modules`;
	const instructionFile = paths.instructionFile ?? HOST_INSTRUCTION_FILES[target];
	const skillRootToken = "__PAVEDA_SKILL_ROOT__";
	const projectRootSkillRootToken = "__PAVEDA_PROJECT_ROOT_SKILL_ROOT__";
	const contextRootToken = "__PAVEDA_CONTEXT_ROOT__";
	const instructionFileToken = "__PAVEDA_INSTRUCTION_FILE__";
	const projectRootSkillRoot = isAbsolute(skillRoot)
		? skillRoot
		: "${PROJECT_ROOT}/".concat(skillRoot);

	const rendered = input
		.replaceAll("${PROJECT_ROOT}/.harness/skills", projectRootSkillRootToken)
		.replaceAll("${PROJECT_ROOT}/.claude/skills", projectRootSkillRootToken)
		.replaceAll(".harness/skills", skillRootToken)
		.replaceAll(".harness/context-modules", contextRootToken)
		.replaceAll(".harness/AGENTS.md", instructionFileToken)
		.replaceAll(".claude/skills", skillRootToken)
		.replaceAll(".claude/context-modules", contextRootToken)
		.replaceAll(".claude/hooks", ".harness/hooks")
		.replaceAll(".claude/checks", ".harness/checks")
		.replaceAll(".claude/CLAUDE.md", instructionFileToken)
		.replaceAll(projectRootSkillRootToken, projectRootSkillRoot)
		.replaceAll(skillRootToken, skillRoot)
		.replaceAll(contextRootToken, contextRoot)
		.replaceAll(instructionFileToken, instructionFile);

	return renderHostModelHints(rendered, target);
}

function renderHostModelHints(input: string, host: HostSkillBundleTarget): string {
	if (!input.startsWith("---\n")) {
		return input;
	}

	const end = input.indexOf("\n---", 4);
	if (end === -1) {
		return input;
	}

	const frontmatter = input.slice(4, end);
	const rest = input.slice(end + 4);
	const renderedFrontmatter = frontmatter.replace(
		/^model:\s*(frontier|standard|frugal)\s*$/gm,
		(_line, tier: ModelTier) => {
			const model = HOST_MODEL_HINTS[host][tier];
			return model ? `model: ${model}` : "";
		},
	);

	return `---\n${renderedFrontmatter}\n---${rest}`;
}

export function renderCodexOpenAiYaml(skill: LoadedSkill): string {
	const displayName = formatDisplayName(skill.name);
	const shortDescription = buildShortDescription(skill, displayName);

	return [
		"interface:",
		`  display_name: ${yamlQuote(displayName)}`,
		`  short_description: ${yamlQuote(shortDescription)}`,
		`  brand_color: ${yamlQuote(CODEX_BRAND_COLOR)}`,
		`  default_prompt: ${yamlQuote(`Use $${skill.name} from the Paveda harness.`)}`,
		"",
		"policy:",
		"  allow_implicit_invocation: true",
		"",
	].join("\n");
}

function isHostSkillBundleTarget(host: string): host is HostSkillBundleTarget {
	return Object.hasOwn(HOST_SKILL_ROOTS, host);
}

function selectSkills(
	builtinSkills: ReturnType<typeof loadSkills>,
	names: string[] | undefined,
): ReturnType<typeof loadSkills> {
	if (!names || names.length === 0) {
		return builtinSkills;
	}

	return names.map((name) => {
		const skill = findSkill(builtinSkills, name);
		if (!skill) {
			throw new Error(`Unknown builtin skill: ${name}`);
		}
		return skill;
	});
}

function selectManifestSkills(
	builtinSkills: ReturnType<typeof loadSkills>,
): ReturnType<typeof loadSkills> {
	const harnessRoot = resolveHarnessRoot(builtinSkills);
	const manifest = harnessRoot ? readHarnessManifest(harnessRoot) : undefined;
	if (!manifest?.skills) {
		return builtinSkills;
	}

	return manifest.skills
		.map((entry) => entry.name)
		.filter((name): name is string => Boolean(name))
		.map((name) => {
			const skill = findSkill(builtinSkills, name);
			if (!skill) {
				throw new Error(`Harness manifest references missing skill: ${name}`);
			}
			return skill;
		});
}

function resolveInstructionFileEntry(
	skills: readonly LoadedSkill[],
	host: HostSkillBundleTarget,
	cwd: string,
	write: boolean,
): HostInstructionFileEntry | undefined {
	const sourcePath = resolveInstructionSourcePath(skills);
	if (!sourcePath) {
		return undefined;
	}

	const targetPath = join(cwd, HOST_INSTRUCTION_FILES[host]);
	const exists = existsSync(targetPath);
	return {
		sourcePath,
		targetPath,
		exists,
		written: write,
		overwritten: exists && write,
	};
}

function resolveInstructionSourcePath(skills: readonly LoadedSkill[]): string | undefined {
	const harnessRoot = resolveHarnessRoot(skills);
	if (!harnessRoot) {
		return undefined;
	}

	const manifest = readHarnessManifest(harnessRoot);
	const sourcePath = join(harnessRoot, manifest?.instructions?.path ?? "AGENTS.md");
	return existsSync(sourcePath) ? sourcePath : undefined;
}

function resolveHostConfigFileEntry(
	host: HostSkillBundleTarget,
	cwd: string,
	write: boolean,
	requiredEntry: string,
): HostConfigFileEntry | undefined {
	if (host !== "hermes") {
		return undefined;
	}

	const targetPath = join(cwd, HERMES_CONFIG_FILE);
	const exists = existsSync(targetPath);
	const registered =
		exists && hermesConfigIncludesExternalSkillDir(readFileSync(targetPath, "utf8"), requiredEntry);

	return {
		targetPath,
		exists,
		written: write && !registered,
		overwritten: false,
		registered,
		requiredEntry,
	};
}

function resolveHarnessRoot(skills: readonly LoadedSkill[]): string | undefined {
	const root = skills[0]?.root;
	return root ? dirname(root) : undefined;
}

function resolvePackagedHarnessRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../../assets/harness");
}

function readHarnessManifest(harnessRoot: string): HarnessManifest | undefined {
	const path = join(harnessRoot, "manifest.json");
	if (!existsSync(path)) {
		return undefined;
	}

	return JSON.parse(readFileSync(path, "utf8")) as HarnessManifest;
}

function resolveContextModuleEntries(
	skills: readonly LoadedSkill[],
	host: HostSkillBundleTarget,
	cwd: string,
	write: boolean,
): HostContextModuleEntry[] {
	const harnessRoot = resolveHarnessRoot(skills);
	if (!harnessRoot) {
		return [];
	}

	const manifest = readHarnessManifest(harnessRoot);
	const sourceRoot = join(harnessRoot, "context-modules");
	if (!existsSync(sourceRoot)) {
		return [];
	}

	const targetRoot = resolveHostContextModuleRoot(host, cwd);
	const manifestPaths = manifest?.contextModules
		?.map((module) => module.path)
		.filter((path): path is string => Boolean(path));
	const contextModulePaths =
		manifestPaths ?? FALLBACK_CONTEXT_MODULE_FILES.map((name) => `context-modules/${name}`);
	const entries = contextModulePaths.map((contextPath) => {
		const name = basename(contextPath);
		const sourcePath = join(harnessRoot, contextPath);
		const targetPath = join(targetRoot, name);
		const exists = existsSync(targetPath);
		return {
			name,
			sourcePath,
			targetPath,
			exists,
			written: write,
			overwritten: exists && write,
		};
	});

	return manifestPaths ? entries : entries.filter((entry) => existsSync(entry.sourcePath));
}

function collectExistingSkillTargetFiles(
	sourceDir: string,
	targetDir: string,
	host: HostSkillBundleTarget,
): HostBundleConflict[] {
	const targetPaths = collectAssetTargetFiles(sourceDir, targetDir);
	if (host === "codex") {
		targetPaths.push(join(targetDir, "agents", "openai.yaml"));
	}

	return targetPaths
		.filter((targetPath) => existsSync(targetPath))
		.map((targetPath) => ({ targetPath }));
}

function collectAssetTargetFiles(sourceDir: string, targetDir: string): string[] {
	const targetPaths: string[] = [];
	if (!existsSync(sourceDir)) {
		return targetPaths;
	}

	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);
		if (entry.isDirectory()) {
			targetPaths.push(...collectAssetTargetFiles(sourcePath, targetPath));
			continue;
		}
		if (entry.isFile()) {
			targetPaths.push(targetPath);
		}
	}

	return targetPaths;
}

function uniqueConflicts<T extends HostBundleConflict>(conflicts: readonly T[]): T[] {
	const seen = new Set<string>();
	return conflicts.filter((conflict) => {
		if (seen.has(conflict.targetPath)) {
			return false;
		}
		seen.add(conflict.targetPath);
		return true;
	});
}

function writeHostInstructionFile(
	sourcePath: string,
	targetPath: string,
	host: HostSkillBundleTarget,
	paths: HostRenderPaths,
): void {
	assertHostBundleTargetPathIsSafe(targetPath);
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, renderHostSkillText(readFileSync(sourcePath, "utf8"), host, paths), {
		mode: statSync(sourcePath).mode,
	});
	chmodSync(targetPath, statSync(sourcePath).mode);
}

function writeHostContextModules(
	entries: readonly HostContextModuleEntry[],
	host: HostSkillBundleTarget,
	paths: HostRenderPaths,
): void {
	for (const entry of entries) {
		copyAssetFileForHost(entry.sourcePath, entry.targetPath, host, paths);
	}
}

function writeHostConfigFile(entry: HostConfigFileEntry): void {
	if (entry.registered) {
		return;
	}

	assertHostBundleTargetPathIsSafe(entry.targetPath);
	const current = entry.exists ? readFileSync(entry.targetPath, "utf8") : "";
	mkdirSync(dirname(entry.targetPath), { recursive: true });
	writeFileSync(
		entry.targetPath,
		renderHermesConfigWithExternalSkillDir(current, entry.requiredEntry),
	);
}

function hermesConfigIncludesExternalSkillDir(content: string, skillDir: string): boolean {
	return new RegExp(`(?:^|\\n)\\s*-\\s*["']?${escapeRegExp(skillDir)}["']?\\s*(?:\\n|$)`).test(
		content,
	);
}

function renderHermesConfigWithExternalSkillDir(content: string, skillDir: string): string {
	if (hermesConfigIncludesExternalSkillDir(content, skillDir)) {
		return content.endsWith("\n") ? content : `${content}\n`;
	}

	if (content.trim().length === 0) {
		return ["skills:", "  external_dirs:", `    - ${skillDir}`, ""].join("\n");
	}

	const lines = content.replace(/\n$/, "").split("\n");
	const skillsIndex = lines.findIndex((line) => /^skills:\s*$/.test(line));
	if (skillsIndex === -1) {
		return [...lines, "", "skills:", "  external_dirs:", `    - ${skillDir}`, ""].join("\n");
	}

	const nextTopLevelIndex = findNextTopLevelYamlKey(lines, skillsIndex + 1);
	const skillsEnd = nextTopLevelIndex === -1 ? lines.length : nextTopLevelIndex;
	const externalDirsIndex = lines.findIndex(
		(line, index) =>
			index > skillsIndex && index < skillsEnd && /^ {2}external_dirs:\s*(?:\[\])?\s*$/.test(line),
	);

	if (externalDirsIndex === -1) {
		lines.splice(skillsIndex + 1, 0, "  external_dirs:", `    - ${skillDir}`);
		return `${lines.join("\n")}\n`;
	}

	if (/^ {2}external_dirs:\s*\[\]\s*$/.test(lines[externalDirsIndex] ?? "")) {
		lines.splice(externalDirsIndex, 1, "  external_dirs:", `    - ${skillDir}`);
		return `${lines.join("\n")}\n`;
	}

	let insertIndex = externalDirsIndex + 1;
	while (insertIndex < skillsEnd && /^ {4}- /.test(lines[insertIndex] ?? "")) {
		insertIndex += 1;
	}
	lines.splice(insertIndex, 0, `    - ${skillDir}`);
	return `${lines.join("\n")}\n`;
}

function findNextTopLevelYamlKey(lines: readonly string[], startIndex: number): number {
	for (let index = startIndex; index < lines.length; index += 1) {
		if (/^[A-Za-z0-9_-]+:\s*/.test(lines[index] ?? "")) {
			return index;
		}
	}

	return -1;
}

function copyAssetDirectoryForHost(
	sourceDir: string,
	targetDir: string,
	host: HostSkillBundleTarget,
	paths: HostRenderPaths,
): void {
	assertHostBundleTargetPathIsSafe(targetDir);
	mkdirSync(targetDir, { recursive: true });

	for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
		const sourcePath = join(sourceDir, entry.name);
		const targetPath = join(targetDir, entry.name);

		if (entry.isDirectory()) {
			copyAssetDirectoryForHost(sourcePath, targetPath, host, paths);
			continue;
		}

		if (entry.isFile()) {
			copyAssetFileForHost(sourcePath, targetPath, host, paths);
		}
	}
}

function copyAssetFileForHost(
	sourcePath: string,
	targetPath: string,
	host: HostSkillBundleTarget,
	paths: HostRenderPaths,
): void {
	assertHostBundleTargetPathIsSafe(targetPath);
	mkdirSync(dirname(targetPath), { recursive: true });
	const mode = statSync(sourcePath).mode;
	if (!isTextAsset(sourcePath)) {
		copyFileSync(sourcePath, targetPath);
		chmodSync(targetPath, mode);
		return;
	}

	writeFileSync(targetPath, renderHostSkillText(readFileSync(sourcePath, "utf8"), host, paths), {
		mode,
	});
	chmodSync(targetPath, mode);
}

function isTextAsset(path: string): boolean {
	return basename(path) === "SKILL.md" || TEXT_EXTENSIONS.has(extname(path));
}

function writeHostGeneratedMetadata(
	skill: LoadedSkill,
	targetDir: string,
	host: HostSkillBundleTarget,
): void {
	if (host !== "codex") {
		return;
	}

	const agentsDir = join(targetDir, "agents");
	assertHostBundleTargetPathIsSafe(join(agentsDir, "openai.yaml"));
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "openai.yaml"), renderCodexOpenAiYaml(skill));
}

function assertHostBundleTargetPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Host skill bundle target");
}

function formatDisplayName(name: string): string {
	return name
		.split("-")
		.filter(Boolean)
		.map((part) => {
			const upper = part.toUpperCase();
			return upper === "PR" || upper === "API" || upper === "CLI" ? upper : capitalize(part);
		})
		.join(" ");
}

function buildShortDescription(skill: LoadedSkill, displayName: string): string {
	const description = String(skill.frontmatter.description ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const firstSentence = description.split(/[.!?。]/)[0]?.trim();
	const base =
		firstSentence && firstSentence.length >= 12
			? firstSentence
			: `Paveda ${displayName} workflow skill`;

	return fitDescription(base);
}

function fitDescription(value: string): string {
	let normalized = value.trim();
	if (normalized.length < MIN_CODEX_DESCRIPTION_LENGTH) {
		const lower = normalized.toLowerCase();
		if (!lower.includes("paveda")) {
			normalized = `Paveda ${normalized}`;
		} else if (!lower.includes("workflow")) {
			normalized = `${normalized} workflow`;
		}
	}
	if (normalized.length <= MAX_CODEX_DESCRIPTION_LENGTH) {
		return normalized;
	}

	const trimmed = normalized
		.slice(0, MAX_CODEX_DESCRIPTION_LENGTH)
		.replace(/\s+\S*$/, "")
		.trim();
	if (trimmed.length >= MIN_CODEX_DESCRIPTION_LENGTH) {
		return trimmed;
	}

	return normalized.slice(0, MAX_CODEX_DESCRIPTION_LENGTH).trim();
}

function capitalize(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function yamlQuote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}
