import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import {
	type HostSkillBundleTarget,
	parseHostSkillBundleTarget,
	resolveCanonicalContextModuleFiles,
	resolveHostContextModuleRoot,
	resolveHostInstructionFilePath,
	resolveHostSkillRoot,
} from "../host-bundles/index.js";
import {
	readClaudeCodeSettings,
	summarizeExistingClaudeCodeInstall,
} from "../install/claude-code.js";
import { type PolicyRuntimeSource, resolvePolicyRuntimeSource } from "../policy/index.js";
import { loadSkillStatus } from "../skill-loader/index.js";
import type { LoadSkillsOptions } from "../skill-loader/index.js";
import { checkEnforcement } from "./enforcement.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorOptions {
	cwd?: string;
	host?: HostSkillBundleTarget | string;
	targetRoot?: string;
	cliCommand?: string;
	enforcement?: boolean;
	policyCachePath?: string;
}

export interface DoctorRecoveryAction {
	command: string;
	description: string;
}

export interface DoctorCheck {
	name: string;
	status: DoctorCheckStatus;
	message: string;
	path?: string;
	details?: unknown;
	recovery?: DoctorRecoveryAction;
}

export interface DoctorResult {
	ok: boolean;
	cwd: string;
	host?: HostSkillBundleTarget;
	targetRoot?: string;
	policySource?: PolicyRuntimeSource;
	checks: DoctorCheck[];
}

const HOST_RENDER_PATHS: Record<
	HostSkillBundleTarget,
	{ projectDir: string; skillRoot: string; contextRoot: string; instructionFile: string }
> = {
	harness: {
		projectDir: ".harness",
		skillRoot: ".harness/skills",
		contextRoot: ".harness/context-modules",
		instructionFile: ".harness/AGENTS.md",
	},
	"claude-code": {
		projectDir: ".claude",
		skillRoot: ".claude/skills",
		contextRoot: ".claude/context-modules",
		instructionFile: ".claude/CLAUDE.md",
	},
	codex: {
		projectDir: ".codex",
		skillRoot: ".codex/skills",
		contextRoot: ".codex/context-modules",
		instructionFile: "AGENTS.md",
	},
	pi: {
		projectDir: ".pi",
		skillRoot: ".pi/skills",
		contextRoot: ".pi/context-modules",
		instructionFile: ".pi/AGENTS.md",
	},
	hermes: {
		projectDir: ".hermes",
		skillRoot: ".hermes/skills",
		contextRoot: ".hermes/context-modules",
		instructionFile: ".hermes/AGENTS.md",
	},
};
const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".sh", ".txt", ".yaml", ".yml"]);
const HERMES_CONFIG_FILE = ".hermes/config.yaml";
const GENERIC_MODEL_TIERS = new Set(["frontier", "standard", "frugal"]);
export function runDoctor(options: DoctorOptions = {}): DoctorResult {
	const cwd = options.cwd ?? process.cwd();
	const host = options.host ? parseHostSkillBundleTarget(options.host) : undefined;
	const skillRoot = host ? resolveHostSkillRoot(host, cwd, options.targetRoot) : undefined;
	const cliCommand = options.cliCommand ?? "paveda";
	const policyCachePath = resolvePolicyCachePathOption(options.policyCachePath);
	const policySource = options.enforcement ? checkPolicySource(cwd, policyCachePath) : undefined;
	const checks: DoctorCheck[] = [
		...checkHostBundle(cwd, host, skillRoot, cliCommand),
		checkDoSkill(cwd, host, skillRoot, cliCommand),
		checkDoRouter(cwd, host, skillRoot, cliCommand),
		checkClaudeCodeSettings(cwd, host, cliCommand),
		checkProjectHooks(cwd),
		checkProjectChecks(cwd),
		...(policySource ? [policySource.check] : []),
		...(options.enforcement
			? checkEnforcement({ cwd, host, policySource: policySource?.policySource })
			: []),
	];

	return {
		ok: checks.every((check) => check.status !== "fail"),
		cwd,
		...(host ? { host } : {}),
		...(options.targetRoot ? { targetRoot: skillRoot } : {}),
		...(policySource ? { policySource: policySource.policySource } : {}),
		checks,
	};
}

export interface PolicySourceDoctorResolution {
	check: DoctorCheck;
	policySource: PolicyRuntimeSource;
}

export function checkPolicySource(
	cwd: string,
	policyCachePath: string | undefined = resolvePolicyCachePathOption(),
): PolicySourceDoctorResolution {
	const resolution = resolvePolicyRuntimeSource({ cachePath: policyCachePath, cwd });
	if (!policyCachePath) {
		return {
			policySource: resolution.policySource,
			check: {
				name: "policy-source",
				status: "warn",
				message: "No verified policy cache is configured; using local runtime policy source.",
				details: { policySource: resolution.policySource },
			},
		};
	}

	if (!resolution.ok) {
		return {
			policySource: resolution.policySource,
			check: {
				name: "policy-source",
				status: "fail",
				message: "Policy cache could not be loaded or verified.",
				path: resolution.cachePath,
				details: { error: resolution.error, policySource: resolution.policySource },
			},
		};
	}

	if (resolution.runtimeDrift && !resolution.runtimeDrift.ok) {
		return {
			policySource: resolution.policySource,
			check: {
				name: "policy-source",
				status: "fail",
				message: "Policy bundle metadata drifts from the local runtime.",
				path: resolution.policySource.cachePath,
				details: {
					policySource: resolution.policySource,
					runtimeDrift: resolution.runtimeDrift,
				},
			},
		};
	}

	const runtimeVersionMatches = resolution.runtimeDrift?.runtimeVersionMatches ?? true;
	if (!runtimeVersionMatches) {
		return {
			policySource: resolution.policySource,
			check: {
				name: "policy-source",
				status: "warn",
				message: `Policy bundle runtime version ${resolution.runtimeDrift?.bundleRuntimeVersion} differs from local runtime ${resolution.runtimeDrift?.localRuntimeVersion}.`,
				path: resolution.policySource.cachePath,
				details: {
					policySource: resolution.policySource,
					runtimeDrift: resolution.runtimeDrift,
				},
			},
		};
	}

	return {
		policySource: resolution.policySource,
		check: {
			name: "policy-source",
			status: "pass",
			message: `Using verified policy bundle ${shortSha(
				resolution.policySource.canonicalSha256,
			)} from ${resolution.policySource.source ?? "cache"}.`,
			path: resolution.policySource.cachePath,
			details: {
				policySource: resolution.policySource,
				runtimeDrift: resolution.runtimeDrift,
			},
		},
	};
}

export function formatDoctorReport(result: DoctorResult): string {
	const lines = [
		"Paveda Doctor",
		`cwd: ${result.cwd}`,
		...(result.host ? [`host: ${result.host}`] : []),
		...(result.targetRoot ? [`targetRoot: ${result.targetRoot}`] : []),
		`status: ${result.ok ? "ok" : "failed"}`,
		"",
	];

	for (const check of result.checks) {
		lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
		if (check.path) {
			lines.push(`  path: ${check.path}`);
		}
		if (check.recovery) {
			lines.push(`  recovery: ${check.recovery.command}`);
		}
	}

	return lines.join("\n");
}

function checkHostBundle(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
	cliCommand: string,
): DoctorCheck[] {
	if (!host || !skillRoot) {
		return [];
	}

	const instructionPath = resolveHostInstructionFilePath(host, cwd);
	const contextModuleRoot = resolveHostContextModuleRoot(host, cwd);
	const installCommand = buildInstallBundleCommand(host, cwd, skillRoot);
	const installRecovery = buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot);
	const missingContextModules = resolveCanonicalContextModuleFiles().filter(
		(name) => !isFile(join(contextModuleRoot, name)),
	);
	return [
		{
			name: "host-skill-root",
			status: isDirectory(skillRoot) ? "pass" : "fail",
			message: isDirectory(skillRoot)
				? "Host skill root exists."
				: `Host skill root is missing. Run ${installCommand}.`,
			path: skillRoot,
			...(isDirectory(skillRoot) ? {} : { recovery: installRecovery }),
		},
		{
			name: "host-instruction-file",
			status: isFile(instructionPath) ? "pass" : "fail",
			message: isFile(instructionPath)
				? "Host instruction file exists."
				: `Host instruction file is missing. Run ${installCommand}.`,
			path: instructionPath,
			...(isFile(instructionPath) ? {} : { recovery: installRecovery }),
		},
		{
			name: "host-context-modules",
			status: missingContextModules.length === 0 ? "pass" : "fail",
			message:
				missingContextModules.length === 0
					? "Host context modules are installed."
					: `Host context modules are incomplete: ${missingContextModules.join(", ")}. Run ${installCommand}.`,
			path: contextModuleRoot,
			details: { missing: missingContextModules },
			...(missingContextModules.length === 0 ? {} : { recovery: installRecovery }),
		},
		...checkHermesSkillRegistration(cwd, host, skillRoot, cliCommand),
		checkHostRenderedPaths(
			cwd,
			host,
			{ skillRoot, instructionPath, contextModuleRoot },
			cliCommand,
		),
		checkHostModelMetadata(cwd, host, skillRoot, cliCommand),
		...checkCodexSkillMetadata(cwd, host, skillRoot, cliCommand),
	];
}

function resolvePolicyCachePathOption(value?: string): string | undefined {
	return value ?? process.env.PAVEDA_POLICY_CACHE;
}

function shortSha(value: string | undefined): string {
	return value ? value.slice(0, 12) : "unknown";
}

function checkHostRenderedPaths(
	cwd: string,
	host: HostSkillBundleTarget,
	paths: { skillRoot: string; instructionPath: string; contextModuleRoot: string },
	cliCommand: string,
): DoctorCheck {
	const missing = [
		...(isDirectory(paths.skillRoot) ? [] : [paths.skillRoot]),
		...(isFile(paths.instructionPath) ? [] : [paths.instructionPath]),
		...(isDirectory(paths.contextModuleRoot) ? [] : [paths.contextModuleRoot]),
	];
	if (missing.length > 0) {
		return {
			name: "host-rendered-paths",
			status: "fail",
			message: "Host bundle files are incomplete, so rendered paths cannot be checked.",
			details: { missing },
			recovery: buildInstallBundleRecovery(cliCommand, host, cwd, paths.skillRoot),
		};
	}

	const forbiddenFragments = buildForbiddenHostPathFragments(host, {
		projectDir: HOST_RENDER_PATHS[host].projectDir,
		skillRoot: formatProjectPath(cwd, paths.skillRoot),
		contextRoot: formatProjectPath(cwd, paths.contextModuleRoot),
		instructionFile: formatProjectPath(cwd, paths.instructionPath),
	});
	const issues = collectTextFiles([paths.instructionPath, paths.skillRoot, paths.contextModuleRoot])
		.flatMap((path) => findForbiddenFragments(path, cwd, forbiddenFragments))
		.sort();

	return {
		name: "host-rendered-paths",
		status: issues.length === 0 ? "pass" : "fail",
		message:
			issues.length === 0
				? "Host bundle text paths are rendered for the selected host."
				: `Host bundle contains stale or invalid rendered paths: ${summarizeIssues(issues)}.`,
		details: { issues },
	};
}

function checkHostModelMetadata(
	cwd: string,
	host: HostSkillBundleTarget,
	skillRoot: string,
	cliCommand: string,
): DoctorCheck {
	if (!isDirectory(skillRoot)) {
		return {
			name: "host-model-metadata",
			status: "fail",
			message: "Host skill root is missing, so model metadata cannot be checked.",
			path: skillRoot,
			recovery: buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot),
		};
	}

	const issues = collectTextFiles([skillRoot])
		.flatMap((path) => findHostModelMetadataIssues(path, cwd, host))
		.sort();

	return {
		name: "host-model-metadata",
		status: issues.length === 0 ? "pass" : "fail",
		message:
			issues.length === 0
				? "Host model metadata is rendered for the selected host."
				: `Host bundle contains unsupported model metadata: ${summarizeIssues(issues)}.`,
		path: skillRoot,
		details: { issues },
	};
}

function checkDoSkill(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
	cliCommand: string,
): DoctorCheck {
	if (host && skillRoot) {
		const path = join(skillRoot, "do", "SKILL.md");
		const installCommand = buildInstallBundleCommand(host, cwd, skillRoot, ["do"]);
		const exists = isFile(path);
		return {
			name: "do-skill",
			status: exists ? "pass" : "fail",
			message: exists
				? "Host /do skill is installed."
				: `Host /do skill is missing. Run ${installCommand}.`,
			path,
			...(exists
				? {}
				: { recovery: buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot, ["do"]) }),
		};
	}

	const status = findSkillStatus(cwd, host, skillRoot);
	const recovery = status ? undefined : buildInstallSkillRecovery(cliCommand, cwd, "do");
	return {
		name: "do-skill",
		status: status ? "pass" : "fail",
		message: status
			? `/do resolves from ${status.selected.scope}.`
			: "/do skill is missing from project, user, and builtin roots.",
		path: status?.selected.path,
		...(recovery ? { recovery } : {}),
	};
}

function checkCodexSkillMetadata(
	cwd: string,
	host: HostSkillBundleTarget,
	skillRoot: string,
	cliCommand: string,
): DoctorCheck[] {
	if (host !== "codex") {
		return [];
	}

	if (!isDirectory(skillRoot)) {
		return [
			{
				name: "host-codex-metadata",
				status: "fail",
				message: "Codex skill root is missing, so skill metadata cannot be checked.",
				path: skillRoot,
				recovery: buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot),
			},
		];
	}

	const missing = readdirSync(skillRoot)
		.map((entry) => join(skillRoot, entry))
		.filter((path) => isDirectory(path) && isFile(join(path, "SKILL.md")))
		.map((path) => join(path, "agents", "openai.yaml"))
		.filter((path) => !isFile(path))
		.map((path) => relative(cwd, path))
		.sort();

	return [
		{
			name: "host-codex-metadata",
			status: missing.length === 0 ? "pass" : "fail",
			message:
				missing.length === 0
					? "Codex skill discovery metadata is installed."
					: `Codex skill discovery metadata is missing: ${summarizeIssues(missing)}.`,
			path: skillRoot,
			details: { missing },
			...(missing.length === 0
				? {}
				: { recovery: buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot, [], true) }),
		},
	];
}

function checkHermesSkillRegistration(
	cwd: string,
	host: HostSkillBundleTarget,
	skillRoot: string,
	cliCommand: string,
): DoctorCheck[] {
	if (host !== "hermes") {
		return [];
	}

	const path = join(cwd, HERMES_CONFIG_FILE);
	const requiredEntry = formatProjectPath(cwd, skillRoot);
	const recovery = buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot, [], true);
	if (!isFile(path)) {
		return [
			{
				name: "host-hermes-config",
				status: "fail",
				message: "Hermes config is missing the project skill directory registration.",
				path,
				details: { requiredEntry },
				recovery,
			},
		];
	}

	const registered = configIncludesExternalSkillDir(readFileSync(path, "utf8"), requiredEntry);
	return [
		{
			name: "host-hermes-config",
			status: registered ? "pass" : "fail",
			message: registered
				? "Hermes config registers the project skill directory."
				: "Hermes config does not register the project skill directory.",
			path,
			details: { requiredEntry },
			...(registered ? {} : { recovery }),
		},
	];
}

function checkDoRouter(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
	cliCommand: string,
): DoctorCheck {
	if (host && skillRoot) {
		const path = join(skillRoot, "do", "SKILL.md");
		if (!isFile(path)) {
			return {
				name: "do-router",
				status: "fail",
				message: "Host /do skill is missing, so router metadata cannot be checked.",
				path,
				recovery: buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot, ["do"]),
			};
		}
	}

	const status = findSkillStatus(cwd, host, skillRoot);
	const recovery =
		status?.routerEnabled === false || !status
			? buildDoRouterRecovery(cliCommand, cwd, host, skillRoot, Boolean(status))
			: undefined;
	return {
		name: "do-router",
		status: status?.routerEnabled ? "pass" : "fail",
		message: status?.routerEnabled
			? "/do router metadata is enabled."
			: "/do router metadata is missing or shadowed.",
		path: status?.selected.path,
		details: status?.issues,
		...(recovery ? { recovery } : {}),
	};
}

function checkClaudeCodeSettings(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	cliCommand: string,
): DoctorCheck {
	const path = join(cwd, ".claude", "settings.json");
	if (!isFile(path)) {
		return {
			name: "claude-code-hooks",
			status: host === "claude-code" ? "fail" : "warn",
			message:
				host === "claude-code"
					? "Claude Code settings are missing."
					: "Claude Code settings are not installed.",
			path,
			...(host === "claude-code" ? { recovery: buildClaudeCodeRecovery(cliCommand, path) } : {}),
		};
	}

	try {
		const summary = summarizeExistingClaudeCodeInstall(readClaudeCodeSettings(path));
		const installed = summary.hooks.every((hook) => hook.installed);
		return {
			name: "claude-code-hooks",
			status: installed ? "pass" : host === "claude-code" ? "fail" : "warn",
			message: installed
				? "Claude Code hook commands are installed for all supported events."
				: "Claude Code hook commands are incomplete.",
			path,
			details: summary,
			...(installed || host !== "claude-code"
				? {}
				: { recovery: buildClaudeCodeRecovery(cliCommand, path) }),
		};
	} catch (error) {
		return {
			name: "claude-code-hooks",
			status: "fail",
			message: error instanceof Error ? error.message : String(error),
			path,
			...(host === "claude-code" ? { recovery: buildClaudeCodeRecovery(cliCommand, path) } : {}),
		};
	}
}

function checkProjectHooks(cwd: string): DoctorCheck {
	const path = join(cwd, ".harness", "hooks");
	const count = countExecutableFiles(path, { recursive: true });
	return {
		name: "project-hooks",
		status: "pass",
		message:
			count === 0
				? "No executable project hooks found."
				: `${count} executable project hook(s) found. They run only after explicit opt-in.`,
		path,
		details: { executableCount: count },
	};
}

function checkProjectChecks(cwd: string): DoctorCheck {
	const path = join(cwd, ".harness", "checks");
	const count = countExecutableFiles(path);
	return {
		name: "project-checks",
		status: "pass",
		message:
			count === 0
				? "No executable project checks found."
				: `${count} executable project check(s) found.`,
		path,
		details: { executableCount: count },
	};
}

function findSkillStatus(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
) {
	return loadSkillStatus(skillLoadOptions(cwd, host, skillRoot)).find(
		(skill) => skill.name === "do",
	);
}

function skillLoadOptions(
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
): LoadSkillsOptions {
	if (!host) {
		return { cwd };
	}

	return {
		cwd,
		projectRoots: [skillRoot ?? resolveHostSkillRoot(host, cwd)],
	};
}

function countExecutableFiles(path: string, options: { recursive?: boolean } = {}): number {
	if (!isDirectory(path)) {
		return 0;
	}

	let count = 0;
	for (const entry of readdirSync(path)) {
		const entryPath = join(path, entry);
		const stat = lstatSync(entryPath);
		if (stat.isFile() && (stat.mode & 0o111) !== 0) {
			count += 1;
		}
		if (options.recursive && stat.isDirectory()) {
			count += countExecutableFiles(entryPath, options);
		}
	}

	return count;
}

function collectTextFiles(paths: string[]): string[] {
	const files: string[] = [];
	for (const path of paths) {
		if (isFile(path) && isTextFile(path)) {
			files.push(path);
			continue;
		}
		if (!isDirectory(path)) {
			continue;
		}
		for (const entry of readdirSync(path)) {
			files.push(...collectTextFiles([join(path, entry)]));
		}
	}

	return files;
}

function findForbiddenFragments(path: string, cwd: string, fragments: string[]): string[] {
	const content = readFileSync(path, "utf8");
	return fragments
		.filter((fragment) => content.includes(fragment))
		.map((fragment) => `${relative(cwd, path)} contains ${fragment}`);
}

function findHostModelMetadataIssues(
	path: string,
	cwd: string,
	host: HostSkillBundleTarget,
): string[] {
	return readFrontmatterModelValues(path).flatMap((model) => {
		const normalized = normalizeYamlScalar(model);
		if (host === "harness") {
			return GENERIC_MODEL_TIERS.has(normalized)
				? []
				: [
						`${relative(cwd, path)} has model: ${model} (expected a generic model tier for harness)`,
					];
		}

		if (host === "claude-code") {
			return GENERIC_MODEL_TIERS.has(normalized)
				? [
						`${relative(cwd, path)} has model: ${model} (generic model tier was not rendered for claude-code)`,
					]
				: [];
		}

		return [
			`${relative(cwd, path)} has model: ${model} (model frontmatter is not supported for ${host})`,
		];
	});
}

function readFrontmatterModelValues(path: string): string[] {
	const content = readFileSync(path, "utf8");
	if (!content.startsWith("---\n")) {
		return [];
	}

	const end = content.indexOf("\n---", 4);
	if (end === -1) {
		return [];
	}

	const frontmatter = content.slice(4, end);
	return frontmatter
		.split("\n")
		.map((line) => line.match(/^model:\s*(.+?)\s*$/)?.[1]?.trim())
		.filter((value): value is string => Boolean(value));
}

function normalizeYamlScalar(value: string): string {
	return value
		.trim()
		.replace(/^["']|["']$/g, "")
		.trim()
		.toLowerCase();
}

function buildForbiddenHostPathFragments(
	host: HostSkillBundleTarget,
	current: { projectDir: string; skillRoot: string; contextRoot: string; instructionFile: string },
): string[] {
	const fragments = new Set<string>();

	for (const paths of Object.values(HOST_RENDER_PATHS)) {
		if (paths.skillRoot !== current.skillRoot) {
			fragments.add(paths.skillRoot);
		}
		if (paths.contextRoot !== current.contextRoot) {
			fragments.add(paths.contextRoot);
		}
		if (paths.instructionFile !== current.instructionFile && paths.instructionFile.includes("/")) {
			fragments.add(paths.instructionFile);
		}
		if (paths.projectDir !== ".harness") {
			fragments.add(`${paths.projectDir}/hooks`);
			fragments.add(`${paths.projectDir}/checks`);
		}
	}

	if (host !== "harness") {
		fragments.add(".harness/skills");
		fragments.add(".harness/context-modules");
		fragments.add(".harness/AGENTS.md");
	}

	fragments.delete(current.skillRoot);
	fragments.delete(current.contextRoot);
	fragments.delete(current.instructionFile);

	return [...fragments].sort();
}

function buildInstallBundleCommand(
	host: HostSkillBundleTarget,
	cwd: string,
	skillRoot: string,
	skills: string[] = [],
): string {
	const defaultRoot = resolveHostSkillRoot(host, cwd);
	const targetRoot = formatProjectPath(cwd, skillRoot);
	const targetRootArg = skillRoot === defaultRoot ? "" : ` --target-root ${targetRoot}`;
	const skillsArg = skills.length > 0 ? ` --skills ${skills.join(",")}` : "";
	return `skills install-bundle --host ${host}${targetRootArg}${skillsArg} --write`;
}

function buildInstallBundleRecovery(
	cliCommand: string,
	host: HostSkillBundleTarget,
	cwd: string,
	skillRoot: string,
	skills: string[] = [],
	force = false,
): DoctorRecoveryAction {
	const defaultRoot = resolveHostSkillRoot(host, cwd);
	const targetRoot = formatProjectPath(cwd, skillRoot);
	const targetRootArg = skillRoot === defaultRoot ? "" : ` --target-root ${shellQuote(targetRoot)}`;
	const skillsArg = skills.length > 0 ? ` --skills ${skills.join(",")}` : "";
	const forceArg = force ? " --force" : "";
	return {
		command: `${cliCommand} skills install-bundle --host ${host} --cwd ${shellQuote(
			cwd,
		)}${targetRootArg}${skillsArg} --write${forceArg}`,
		description: force
			? "Re-render the host bundle, overwriting existing generated host files."
			: "Install the missing host bundle files.",
	};
}

function buildInstallSkillRecovery(
	cliCommand: string,
	cwd: string,
	name: string,
): DoctorRecoveryAction {
	return {
		command: `${cliCommand} skills install ${name} --cwd ${shellQuote(cwd)} --write`,
		description: "Install the missing builtin skill into the project harness skill root.",
	};
}

function buildDoRouterRecovery(
	cliCommand: string,
	cwd: string,
	host: HostSkillBundleTarget | undefined,
	skillRoot: string | undefined,
	hasSkill: boolean,
): DoctorRecoveryAction {
	if (host && skillRoot) {
		return buildInstallBundleRecovery(cliCommand, host, cwd, skillRoot, ["do"], hasSkill);
	}

	if (!hasSkill) {
		return buildInstallSkillRecovery(cliCommand, cwd, "do");
	}

	return {
		command: `${cliCommand} skills enable-router do --cwd ${shellQuote(cwd)} --write`,
		description: "Enable /do router metadata on the selected project skill.",
	};
}

function buildClaudeCodeRecovery(cliCommand: string, settingsPath: string): DoctorRecoveryAction {
	return {
		command: `${cliCommand} install claude-code --path ${shellQuote(settingsPath)} --write`,
		description: "Install or repair Claude Code hook settings.",
	};
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value;
	}

	return `'${value.replaceAll("'", "'\\''")}'`;
}

function configIncludesExternalSkillDir(content: string, skillDir: string): boolean {
	return new RegExp(`(?:^|\\n)\\s*-\\s*["']?${escapeRegExp(skillDir)}["']?\\s*(?:\\n|$)`).test(
		content,
	);
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

function summarizeIssues(issues: string[]): string {
	const shown = issues.slice(0, 3).join(", ");
	return issues.length > 3 ? `${shown}, +${issues.length - 3} more` : shown;
}

function isTextFile(path: string): boolean {
	return TEXT_EXTENSIONS.has(extname(path));
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}
