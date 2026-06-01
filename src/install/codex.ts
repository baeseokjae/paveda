import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

export interface CodexHooksConfig {
	hooks?: Record<string, CodexHookMatcher[]>;
	[key: string]: unknown;
}

export interface CodexHookMatcher {
	matcher?: string;
	hooks: CodexHookCommand[];
	[key: string]: unknown;
}

export interface CodexHookCommand {
	type: "command";
	command: string;
	timeout?: number;
	statusMessage?: string;
	commandWindows?: string;
	command_windows?: string;
	[key: string]: unknown;
}

export interface InstallCodexOptions {
	path?: string;
	command?: string;
	cliPath?: string;
	managed?: boolean;
	requirementsPath?: string;
	managedDir?: string;
	allowManagedHooksOnly?: boolean;
	write?: boolean;
	force?: boolean;
}

export interface InstallCodexResult {
	path: string;
	hooksConfig: CodexHooksConfig;
	requirementsPath?: string;
	requirementsToml?: string;
	written: boolean;
	changed: boolean;
	summary: CodexInstallSummary;
}

export interface CodexInstallSummary {
	command: string;
	hooks: CodexHookInstallStatus[];
	managed: boolean;
	requirementsPath?: string;
	allowManagedHooksOnly?: boolean;
	managedDir?: string;
}

export interface CodexHookInstallStatus {
	event: string;
	matcher?: string;
	installed: boolean;
	commandCount: number;
}

const DEFAULT_HOOKS_PATH = ".codex/hooks.json";
const DEFAULT_REQUIREMENTS_PATH = "requirements.toml";
const DEFAULT_HOOK_COMMAND = "paveda hook codex";
const DEFAULT_MANAGED_DIR = ".codex/hooks";
const PAVEDA_REQUIREMENTS_BEGIN = "# BEGIN PAVEDA MANAGED CODEX POLICY";
const PAVEDA_REQUIREMENTS_END = "# END PAVEDA MANAGED CODEX POLICY";

const HOOK_MATCHERS: readonly [event: string, matcher?: string, statusMessage?: string][] = [
	["SessionStart", "startup|resume|clear|compact", "Loading Paveda session policy"],
	["UserPromptSubmit", undefined, "Checking Paveda prompt policy"],
	["PreToolUse", "Bash", "Checking Paveda Bash policy"],
	["PreToolUse", "apply_patch|Edit|Write", "Checking Paveda file mutation policy"],
	["PreToolUse", "mcp__.*", "Checking Paveda MCP policy"],
	["PermissionRequest", "Bash|apply_patch|Edit|Write|mcp__.*", "Checking Paveda permission policy"],
	["PostToolUse", "Bash|apply_patch|Edit|Write|mcp__.*", "Recording Paveda tool result policy"],
	["Stop", undefined, "Checking Paveda handoff policy"],
];

export function installCodex(options: InstallCodexOptions = {}): InstallCodexResult {
	const path = options.path ?? DEFAULT_HOOKS_PATH;
	assertCodexHooksPathIsSafe(path);
	const command = options.command ?? defaultHookCommand(options.cliPath);
	const current = readHooksConfig(path);
	const hooksConfig = addPavedaCodexHooks(current, command);
	const requirementsPath = options.requirementsPath ?? DEFAULT_REQUIREMENTS_PATH;
	const requirementsToml = options.managed
		? renderCodexRequirementsToml({
				command,
				managedDir: options.managedDir ?? DEFAULT_MANAGED_DIR,
				allowManagedHooksOnly: options.allowManagedHooksOnly ?? true,
			})
		: undefined;
	const existingRequirements = options.managed ? readTextIfExists(requirementsPath) : undefined;
	const nextRequirements =
		requirementsToml && existingRequirements !== undefined
			? upsertRequirementsBlock(existingRequirements, requirementsToml, {
					path: requirementsPath,
					force: Boolean(options.force),
				})
			: requirementsToml;
	const changed =
		!sameConfig(current, hooksConfig) ||
		(Boolean(options.managed) && existingRequirements !== nextRequirements);

	if (options.write) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(hooksConfig, null, 2)}\n`);

		if (options.managed && nextRequirements) {
			assertCodexRequirementsPathIsSafe(requirementsPath);
			mkdirSync(dirname(requirementsPath), { recursive: true });
			writeFileSync(requirementsPath, `${nextRequirements.trimEnd()}\n`);
		}
	}

	return {
		path,
		hooksConfig,
		...(options.managed
			? { requirementsPath, requirementsToml: nextRequirements ?? requirementsToml }
			: {}),
		written: Boolean(options.write),
		changed,
		summary: summarizeCodexInstall(hooksConfig, {
			command,
			managed: Boolean(options.managed),
			requirementsPath: options.managed ? requirementsPath : undefined,
			allowManagedHooksOnly: options.managed ? (options.allowManagedHooksOnly ?? true) : undefined,
			managedDir: options.managed ? (options.managedDir ?? DEFAULT_MANAGED_DIR) : undefined,
		}),
	};
}

export function readCodexHooksConfig(path = DEFAULT_HOOKS_PATH): CodexHooksConfig {
	assertCodexHooksPathIsSafe(path);
	return readHooksConfig(path);
}

export function addPavedaCodexHooks(
	config: CodexHooksConfig,
	command = DEFAULT_HOOK_COMMAND,
): CodexHooksConfig {
	const next: CodexHooksConfig = {
		...config,
		hooks: { ...(config.hooks ?? {}) },
	};

	for (const [event, matcher, statusMessage] of HOOK_MATCHERS) {
		const entries = [...(next.hooks?.[event] ?? [])];
		const target = findOrCreateMatcher(entries, matcher);
		target.hooks = target.hooks.filter((hook) => !isPavedaHookCommand(hook.command));

		if (!target.hooks.some((hook) => hook.type === "command" && hook.command === command)) {
			target.hooks = [
				...target.hooks,
				{
					type: "command",
					command,
					timeout: 30,
					...(statusMessage ? { statusMessage } : {}),
				},
			];
		}

		next.hooks = {
			...next.hooks,
			[event]: entries,
		};
	}

	return next;
}

export function renderCodexRequirementsToml(input: {
	command: string;
	managedDir?: string;
	allowManagedHooksOnly?: boolean;
}): string {
	const managedDir = input.managedDir ?? DEFAULT_MANAGED_DIR;
	const allowManagedHooksOnly = input.allowManagedHooksOnly ?? true;
	const command = tomlString(input.command);

	return [
		PAVEDA_REQUIREMENTS_BEGIN,
		`allow_managed_hooks_only = ${allowManagedHooksOnly}`,
		'allowed_sandbox_modes = ["read-only", "workspace-write"]',
		'allowed_approval_policies = ["untrusted", "on-request", "granular"]',
		'allowed_web_search_modes = ["disabled", "cached"]',
		"",
		"[features]",
		"hooks = true",
		"",
		"[hooks]",
		`managed_dir = ${tomlString(managedDir)}`,
		"",
		renderManagedHook("PreToolUse", "^Bash$", command, "Checking managed Paveda Bash policy"),
		renderManagedHook(
			"PreToolUse",
			"^apply_patch$|^Edit$|^Write$",
			command,
			"Checking managed Paveda file mutation policy",
		),
		renderManagedHook(
			"PermissionRequest",
			"^Bash$|^apply_patch$|^Edit$|^Write$|^mcp__.*",
			command,
			"Checking managed Paveda permission policy",
		),
		renderManagedHook(
			"PostToolUse",
			"^Bash$|^apply_patch$|^Edit$|^Write$|^mcp__.*",
			command,
			"Recording managed Paveda tool result policy",
		),
		"[[rules.prefix_rules]]",
		'decision = "forbidden"',
		'justification = "Paveda blocks direct .env file writes; use secure configuration instead."',
		"[[rules.prefix_rules.pattern]]",
		'any_of = ["echo", "printf", "tee"]',
		"[[rules.prefix_rules.pattern]]",
		'any_of = [">", ">>"]',
		"[[rules.prefix_rules.pattern]]",
		'token = ".env"',
		PAVEDA_REQUIREMENTS_END,
		"",
	].join("\n");
}

export function summarizeCodexInstall(
	config: CodexHooksConfig,
	input: {
		command?: string;
		managed?: boolean;
		requirementsPath?: string;
		allowManagedHooksOnly?: boolean;
		managedDir?: string;
	} = {},
): CodexInstallSummary {
	const command = input.command ?? DEFAULT_HOOK_COMMAND;
	return {
		command,
		hooks: HOOK_MATCHERS.map(([event, matcher]) => {
			const hooks = findMatcher(config.hooks?.[event] ?? [], matcher)?.hooks ?? [];
			return {
				event,
				...(matcher ? { matcher } : {}),
				installed: hooks.some((hook) => hook.type === "command" && hook.command === command),
				commandCount: hooks.filter((hook) => hook.type === "command").length,
			};
		}),
		managed: Boolean(input.managed),
		...(input.requirementsPath ? { requirementsPath: input.requirementsPath } : {}),
		...(input.allowManagedHooksOnly !== undefined
			? { allowManagedHooksOnly: input.allowManagedHooksOnly }
			: {}),
		...(input.managedDir ? { managedDir: input.managedDir } : {}),
	};
}

export function assertCodexHooksPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Codex hooks path");
}

export function assertCodexRequirementsPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Codex requirements path");
}

function renderManagedHook(
	event: string,
	matcher: string,
	command: string,
	statusMessage: string,
): string {
	return [
		`[[hooks.${event}]]`,
		`matcher = ${tomlString(matcher)}`,
		`[[hooks.${event}.hooks]]`,
		'type = "command"',
		`command = ${command}`,
		"timeout = 30",
		`statusMessage = ${tomlString(statusMessage)}`,
		"",
	].join("\n");
}

function upsertRequirementsBlock(
	existing: string,
	block: string,
	options: { path: string; force: boolean },
): string {
	if (existing.includes(PAVEDA_REQUIREMENTS_BEGIN) && existing.includes(PAVEDA_REQUIREMENTS_END)) {
		const start = existing.indexOf(PAVEDA_REQUIREMENTS_BEGIN);
		const end = existing.indexOf(PAVEDA_REQUIREMENTS_END) + PAVEDA_REQUIREMENTS_END.length;
		return `${existing.slice(0, start)}${block.trimEnd()}${existing.slice(end)}`;
	}

	if (!options.force && existing.trim().length > 0) {
		throw new Error(
			`Codex requirements file already exists without a Paveda managed block: ${options.path}. Use --force to append Paveda policy.`,
		);
	}

	return existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${block}` : block;
}

function readHooksConfig(path: string): CodexHooksConfig {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;

		if (!isConfigObject(parsed)) {
			throw new Error(`Codex hooks config must be a JSON object: ${path}`);
		}

		return parsed;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {};
		}

		throw error;
	}
}

function readTextIfExists(path: string): string | undefined {
	assertCodexRequirementsPathIsSafe(path);
	if (!existsSync(path)) {
		return undefined;
	}

	return readFileSync(path, "utf8");
}

function defaultHookCommand(cliPath: string | undefined): string {
	return cliPath ? `node ${shellQuote(cliPath)} hook codex` : DEFAULT_HOOK_COMMAND;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isPavedaHookCommand(command: string): boolean {
	return command === DEFAULT_HOOK_COMMAND || /\bpaveda\s+hook\s+codex\b/.test(command);
}

function findOrCreateMatcher(
	entries: CodexHookMatcher[],
	matcher: string | undefined,
): CodexHookMatcher {
	const existing = findMatcher(entries, matcher);
	if (existing) {
		return existing;
	}

	const created: CodexHookMatcher = matcher ? { matcher, hooks: [] } : { hooks: [] };
	entries.push(created);
	return created;
}

function findMatcher(
	entries: readonly CodexHookMatcher[],
	matcher: string | undefined,
): CodexHookMatcher | undefined {
	return entries.find((entry) => entry.matcher === matcher);
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function sameConfig(left: CodexHooksConfig, right: CodexHooksConfig): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isConfigObject(value: unknown): value is CodexHooksConfig {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
