import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HookProfile } from "../core/index.js";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

export interface ClaudeCodeSettings {
	hooks?: Record<string, ClaudeCodeHookMatcher[]>;
	env?: Record<string, string>;
	[key: string]: unknown;
}

export interface ClaudeCodeHookMatcher {
	matcher?: string;
	hooks: ClaudeCodeHookCommand[];
	[key: string]: unknown;
}

export interface ClaudeCodeHookCommand {
	type: "command";
	command: string;
	[key: string]: unknown;
}

export interface InstallClaudeCodeOptions {
	path?: string;
	command?: string;
	cliPath?: string;
	profile?: HookProfile;
	disabledHooks?: string;
	projectHooks?: boolean;
	sessionStartContext?: boolean;
	sessionStartMaxChars?: number;
	write?: boolean;
}

export interface InstallClaudeCodeResult {
	path: string;
	settings: ClaudeCodeSettings;
	written: boolean;
	changed: boolean;
	summary: ClaudeCodeInstallSummary;
}

export interface ClaudeCodeInstallSummary {
	command: string;
	hooks: ClaudeCodeHookInstallStatus[];
	env: {
		profile?: string;
		sessionStartMaxChars?: string;
		cliPath?: string;
		disabledHooks?: string;
		projectHooks?: string;
		sessionStartContext?: string;
	};
}

export interface ClaudeCodeHookInstallStatus {
	event: string;
	matcher?: string;
	installed: boolean;
	commandCount: number;
}

const DEFAULT_SETTINGS_PATH = ".claude/settings.json";
const DEFAULT_HOOK_COMMAND = "paveda hook claude-code";
const DEFAULT_PROFILE: HookProfile = "standard";
const DEFAULT_SESSION_START_MAX_CHARS = 8000;

const HOOK_MATCHERS: readonly [event: string, matcher?: string][] = [
	["SessionStart"],
	["PreToolUse", "*"],
	["PostToolUse", "*"],
	["Stop"],
];

export function installClaudeCode(options: InstallClaudeCodeOptions = {}): InstallClaudeCodeResult {
	const path = options.path ?? DEFAULT_SETTINGS_PATH;
	assertClaudeCodeSettingsPathIsSafe(path);
	const command = options.command ?? defaultHookCommand(options.cliPath);
	const current = readSettings(path);
	const settings = addPavedaClaudeCodeSettings(current, {
		command,
		cliPath: options.cliPath,
		profile: options.profile,
		disabledHooks: options.disabledHooks,
		projectHooks: options.projectHooks,
		sessionStartContext: options.sessionStartContext,
		sessionStartMaxChars: options.sessionStartMaxChars,
	});

	if (options.write) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	}

	return {
		path,
		settings,
		written: Boolean(options.write),
		changed: !sameSettings(current, settings),
		summary: summarizeClaudeCodeInstall(settings, command),
	};
}

export function readClaudeCodeSettings(path = DEFAULT_SETTINGS_PATH): ClaudeCodeSettings {
	assertClaudeCodeSettingsPathIsSafe(path);
	return readSettings(path);
}

export interface AddPavedaClaudeCodeSettingsOptions {
	command?: string;
	cliPath?: string;
	profile?: HookProfile;
	disabledHooks?: string;
	projectHooks?: boolean;
	sessionStartContext?: boolean;
	sessionStartMaxChars?: number;
}

export function addPavedaClaudeCodeSettings(
	settings: ClaudeCodeSettings,
	options: AddPavedaClaudeCodeSettingsOptions = {},
): ClaudeCodeSettings {
	return addPavedaEnv(
		addPavedaHooks(settings, options.command ?? defaultHookCommand(options.cliPath)),
		options,
	);
}

export function addPavedaHooks(
	settings: ClaudeCodeSettings,
	command = DEFAULT_HOOK_COMMAND,
): ClaudeCodeSettings {
	const next: ClaudeCodeSettings = {
		...settings,
		hooks: { ...(settings.hooks ?? {}) },
	};

	for (const [event, matcher] of HOOK_MATCHERS) {
		const entries = [...(next.hooks?.[event] ?? [])];
		const target = findOrCreateMatcher(entries, matcher);
		target.hooks = target.hooks.filter((hook) => !isPavedaHookCommand(hook.command));

		if (!target.hooks.some((hook) => hook.type === "command" && hook.command === command)) {
			target.hooks = [...target.hooks, { type: "command", command }];
		}

		next.hooks = {
			...next.hooks,
			[event]: entries,
		};
	}

	return next;
}

export function addPavedaEnv(
	settings: ClaudeCodeSettings,
	options: AddPavedaClaudeCodeSettingsOptions = {},
): ClaudeCodeSettings {
	const env: Record<string, string> = {
		...(settings.env ?? {}),
		PAVEDA_HOOK_PROFILE: options.profile ?? settings.env?.PAVEDA_HOOK_PROFILE ?? DEFAULT_PROFILE,
		PAVEDA_SESSION_START_MAX_CHARS: String(
			options.sessionStartMaxChars ??
				settings.env?.PAVEDA_SESSION_START_MAX_CHARS ??
				DEFAULT_SESSION_START_MAX_CHARS,
		),
	};

	if (options.cliPath !== undefined) {
		env.PAVEDA_CLI = options.cliPath;
	}

	if (options.disabledHooks !== undefined) {
		env.PAVEDA_DISABLED_HOOKS = options.disabledHooks;
	}

	if (options.projectHooks !== undefined) {
		env.PAVEDA_PROJECT_HOOKS = options.projectHooks ? "on" : "off";
	}

	if (options.sessionStartContext !== undefined) {
		env.PAVEDA_SESSION_START_CONTEXT = options.sessionStartContext ? "on" : "off";
	}

	return {
		...settings,
		env,
	};
}

export function summarizeClaudeCodeInstall(
	settings: ClaudeCodeSettings,
	command = DEFAULT_HOOK_COMMAND,
): ClaudeCodeInstallSummary {
	return {
		command,
		hooks: HOOK_MATCHERS.map(([event, matcher]) => {
			const hooks = findMatcher(settings.hooks?.[event] ?? [], matcher)?.hooks ?? [];
			return {
				event,
				...(matcher ? { matcher } : {}),
				installed: hooks.some((hook) => hook.type === "command" && hook.command === command),
				commandCount: hooks.filter((hook) => hook.type === "command").length,
			};
		}),
		env: {
			profile: settings.env?.PAVEDA_HOOK_PROFILE,
			sessionStartMaxChars: settings.env?.PAVEDA_SESSION_START_MAX_CHARS,
			cliPath: settings.env?.PAVEDA_CLI,
			disabledHooks: settings.env?.PAVEDA_DISABLED_HOOKS,
			projectHooks: settings.env?.PAVEDA_PROJECT_HOOKS,
			sessionStartContext: settings.env?.PAVEDA_SESSION_START_CONTEXT,
		},
	};
}

export function summarizeExistingClaudeCodeInstall(
	settings: ClaudeCodeSettings,
): ClaudeCodeInstallSummary {
	const command = findFirstPavedaHookCommand(settings) ?? DEFAULT_HOOK_COMMAND;
	return {
		command,
		hooks: HOOK_MATCHERS.map(([event, matcher]) => {
			const hooks = findMatcher(settings.hooks?.[event] ?? [], matcher)?.hooks ?? [];
			return {
				event,
				...(matcher ? { matcher } : {}),
				installed: hooks.some(
					(hook) => hook.type === "command" && isPavedaHookCommand(hook.command),
				),
				commandCount: hooks.filter((hook) => hook.type === "command").length,
			};
		}),
		env: {
			profile: settings.env?.PAVEDA_HOOK_PROFILE,
			sessionStartMaxChars: settings.env?.PAVEDA_SESSION_START_MAX_CHARS,
			cliPath: settings.env?.PAVEDA_CLI,
			disabledHooks: settings.env?.PAVEDA_DISABLED_HOOKS,
			projectHooks: settings.env?.PAVEDA_PROJECT_HOOKS,
			sessionStartContext: settings.env?.PAVEDA_SESSION_START_CONTEXT,
		},
	};
}

function readSettings(path: string): ClaudeCodeSettings {
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as unknown;

		if (!isSettingsObject(parsed)) {
			throw new Error(`Claude Code settings must be a JSON object: ${path}`);
		}

		return parsed;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {};
		}

		throw error;
	}
}

export function assertClaudeCodeSettingsPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Claude Code settings path");
}

function defaultHookCommand(cliPath: string | undefined): string {
	return cliPath ? `node ${shellQuote(cliPath)} hook claude-code` : DEFAULT_HOOK_COMMAND;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isPavedaHookCommand(command: string): boolean {
	return (
		command === DEFAULT_HOOK_COMMAND ||
		command.includes("paveda-hook.sh") ||
		/(\s|^)node\s+.+\bdist\/cli\.js\s+hook\s+claude-code(\s|$)/.test(command)
	);
}

function findFirstPavedaHookCommand(settings: ClaudeCodeSettings): string | undefined {
	for (const entries of Object.values(settings.hooks ?? {})) {
		for (const entry of entries) {
			const hook = entry.hooks.find(
				(item) => item.type === "command" && isPavedaHookCommand(item.command),
			);
			if (hook) {
				return hook.command;
			}
		}
	}

	return undefined;
}

function findOrCreateMatcher(
	entries: ClaudeCodeHookMatcher[],
	matcher: string | undefined,
): ClaudeCodeHookMatcher {
	const existing = findMatcher(entries, matcher);
	if (existing) {
		return existing;
	}

	const created: ClaudeCodeHookMatcher = matcher ? { matcher, hooks: [] } : { hooks: [] };
	entries.push(created);
	return created;
}

function findMatcher(
	entries: readonly ClaudeCodeHookMatcher[],
	matcher: string | undefined,
): ClaudeCodeHookMatcher | undefined {
	return entries.find((entry) => entry.matcher === matcher);
}

function sameSettings(left: ClaudeCodeSettings, right: ClaudeCodeSettings): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isSettingsObject(value: unknown): value is ClaudeCodeSettings {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
