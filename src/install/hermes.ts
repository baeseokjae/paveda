import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

export interface InstallHermesOptions {
	configPath?: string;
	hookPath?: string;
	command?: string;
	cliPath?: string;
	hooksAutoAccept?: boolean;
	write?: boolean;
	force?: boolean;
}

export interface InstallHermesResult {
	configPath: string;
	hookPath: string;
	configYaml: string;
	hookScript: string;
	written: boolean;
	changed: boolean;
	summary: HermesInstallSummary;
}

export interface HermesInstallSummary {
	hookCommand: string;
	runtimeCommand: string;
	hooksAutoAccept: boolean;
	hooks: HermesHookInstallStatus[];
}

export interface HermesHookInstallStatus {
	event: string;
	matcher?: string;
	installed: boolean;
}

const DEFAULT_CONFIG_PATH = ".hermes/config.yaml";
const DEFAULT_HOOK_PATH = ".hermes/agent-hooks/paveda-policy.sh";
const DEFAULT_RUNTIME_COMMAND = "paveda hook hermes";
const PAVEDA_HERMES_BEGIN = "# BEGIN PAVEDA MANAGED HERMES POLICY";
const PAVEDA_HERMES_END = "# END PAVEDA MANAGED HERMES POLICY";

const HERMES_HOOKS: readonly [event: string, matcher?: string][] = [
	["on_session_start"],
	["pre_llm_call"],
	["pre_tool_call", "terminal|bash|shell|write_file|write|edit_file|edit|patch"],
	["pre_approval_request", "terminal|bash|shell|write_file|write|edit_file|edit|patch"],
	["post_tool_call", "terminal|bash|shell|write_file|write|edit_file|edit|patch|delegate_task"],
	["post_approval_response", "terminal|bash|shell|write_file|write|edit_file|edit|patch"],
	["on_session_end"],
];

export function installHermes(options: InstallHermesOptions = {}): InstallHermesResult {
	const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
	const hookPath = options.hookPath ?? DEFAULT_HOOK_PATH;
	assertHermesConfigPathIsSafe(configPath);
	assertHermesHookPathIsSafe(hookPath);

	const runtimeCommand = options.command ?? defaultRuntimeCommand(options.cliPath);
	const hookCommand = shellQuote(hookPath);
	const currentConfig = readTextIfExists(configPath) ?? "";
	const currentHookScript = readTextIfExists(hookPath);
	if (currentHookScript && !isPavedaHermesHookScript(currentHookScript) && !options.force) {
		throw new Error(
			`Hermes hook script already exists without a Paveda managed block: ${hookPath}. Use --force to replace it.`,
		);
	}

	const hookScript = renderHermesHookScript(runtimeCommand);
	const configYaml = addPavedaHermesHooks(currentConfig, {
		command: hookCommand,
		hooksAutoAccept: Boolean(options.hooksAutoAccept),
	});
	const changed = currentConfig !== configYaml || currentHookScript !== hookScript;

	if (options.write) {
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, configYaml);
		mkdirSync(dirname(hookPath), { recursive: true });
		writeFileSync(hookPath, hookScript, { mode: 0o755 });
		chmodSync(hookPath, 0o755);
	}

	return {
		configPath,
		hookPath,
		configYaml,
		hookScript,
		written: Boolean(options.write),
		changed,
		summary: summarizeHermesInstall(configYaml, {
			hookCommand,
			runtimeCommand,
			hooksAutoAccept: Boolean(options.hooksAutoAccept),
		}),
	};
}

export function addPavedaHermesHooks(
	content: string,
	input: { command?: string; hooksAutoAccept?: boolean } = {},
): string {
	const command = input.command ?? shellQuote(DEFAULT_HOOK_PATH);
	const lines = stripPavedaHermesHookEntries(content.replace(/\n$/, "").split("\n"));
	if (lines.length === 1 && lines[0] === "") {
		lines.pop();
	}

	let hooksIndex = findTopLevelYamlKey(lines, "hooks");
	if (hooksIndex === -1) {
		if (lines.length > 0 && lines[lines.length - 1] !== "") {
			lines.push("");
		}
		hooksIndex = lines.length;
		lines.push("hooks:");
	}

	for (const [event, matcher] of HERMES_HOOKS) {
		ensureHermesHook(lines, hooksIndex, event, matcher, command);
	}

	if (input.hooksAutoAccept) {
		setTopLevelYamlScalar(lines, "hooks_auto_accept", "true");
	}

	return `${lines.join("\n")}\n`;
}

export function renderHermesHookScript(command = DEFAULT_RUNTIME_COMMAND): string {
	return [
		"#!/usr/bin/env bash",
		PAVEDA_HERMES_BEGIN,
		"set -euo pipefail",
		`exec ${command}`,
		PAVEDA_HERMES_END,
		"",
	].join("\n");
}

export function summarizeHermesInstall(
	configYaml: string,
	input: {
		hookCommand?: string;
		runtimeCommand?: string;
		hooksAutoAccept?: boolean;
	} = {},
): HermesInstallSummary {
	const hookCommand = input.hookCommand ?? shellQuote(DEFAULT_HOOK_PATH);
	return {
		hookCommand,
		runtimeCommand: input.runtimeCommand ?? DEFAULT_RUNTIME_COMMAND,
		hooksAutoAccept: Boolean(input.hooksAutoAccept),
		hooks: HERMES_HOOKS.map(([event, matcher]) => ({
			event,
			...(matcher ? { matcher } : {}),
			installed: hermesHookInstalled(configYaml, event, hookCommand),
		})),
	};
}

export function assertHermesConfigPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Hermes config path");
}

export function assertHermesHookPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Hermes hook path");
}

function ensureHermesHook(
	lines: string[],
	hooksIndex: number,
	event: string,
	matcher: string | undefined,
	command: string,
): void {
	const hooksEnd = findNextTopLevelYamlKey(lines, hooksIndex + 1);
	const sectionEnd = hooksEnd === -1 ? lines.length : hooksEnd;
	const eventIndex = findNestedYamlKey(lines, event, hooksIndex + 1, sectionEnd);

	if (eventIndex === -1) {
		lines.splice(sectionEnd, 0, ...renderHermesEventHookLines(event, matcher, command));
		return;
	}

	if (/^ {2}\S+:\s*\[\]\s*$/.test(lines[eventIndex] ?? "")) {
		lines.splice(eventIndex, 1, ...renderHermesEventHookLines(event, matcher, command));
		return;
	}

	const eventEnd = findNextNestedYamlKey(lines, eventIndex + 1, sectionEnd);
	const insertIndex = eventEnd === -1 ? sectionEnd : eventEnd;
	const eventLines = lines.slice(eventIndex, insertIndex);
	if (eventLines.some((line) => line.includes(command))) {
		return;
	}

	lines.splice(insertIndex, 0, ...renderHermesHookEntryLines(matcher, command));
}

function renderHermesEventHookLines(
	event: string,
	matcher: string | undefined,
	command: string,
): string[] {
	return [`  ${event}:`, ...renderHermesHookEntryLines(matcher, command)];
}

function renderHermesHookEntryLines(matcher: string | undefined, command: string): string[] {
	return [
		...(matcher ? [`    - matcher: ${yamlString(matcher)}`] : ["    - command: PLACEHOLDER"]),
		...(matcher ? [`      command: ${command}`] : []),
		...(matcher ? ["      timeout: 30"] : []),
		...(matcher ? [] : ["      timeout: 30"]),
	].map((line) => (line === "    - command: PLACEHOLDER" ? `    - command: ${command}` : line));
}

function stripPavedaHermesHookEntries(lines: string[]): string[] {
	const next: string[] = [];
	for (let index = 0; index < lines.length; ) {
		const line = lines[index] ?? "";
		if (!/^ {4}- /.test(line)) {
			next.push(line);
			index += 1;
			continue;
		}

		let end = index + 1;
		while (end < lines.length && (lines[end]?.trim() === "" || /^ {6,}/.test(lines[end] ?? ""))) {
			end += 1;
		}
		const block = lines.slice(index, end);
		if (!block.some(isPavedaHermesHookLine)) {
			next.push(...block);
		}
		index = end;
	}

	return next;
}

function hermesHookInstalled(configYaml: string, event: string, command: string): boolean {
	const lines = configYaml.split("\n");
	const hooksIndex = findTopLevelYamlKey(lines, "hooks");
	if (hooksIndex === -1) {
		return false;
	}
	const hooksEnd = findNextTopLevelYamlKey(lines, hooksIndex + 1);
	const sectionEnd = hooksEnd === -1 ? lines.length : hooksEnd;
	const eventIndex = findNestedYamlKey(lines, event, hooksIndex + 1, sectionEnd);
	if (eventIndex === -1) {
		return false;
	}
	const eventEnd = findNextNestedYamlKey(lines, eventIndex + 1, sectionEnd);
	return lines
		.slice(eventIndex, eventEnd === -1 ? sectionEnd : eventEnd)
		.some((line) => line.includes(command));
}

function findTopLevelYamlKey(lines: readonly string[], key: string): number {
	return lines.findIndex((line) => new RegExp(`^${escapeRegExp(key)}:\\s*(?:.*)?$`).test(line));
}

function findNestedYamlKey(
	lines: readonly string[],
	key: string,
	start: number,
	end: number,
): number {
	for (let index = start; index < end; index += 1) {
		if (new RegExp(`^ {2}${escapeRegExp(key)}:\\s*(?:.*)?$`).test(lines[index] ?? "")) {
			return index;
		}
	}
	return -1;
}

function findNextTopLevelYamlKey(lines: readonly string[], start: number): number {
	for (let index = start; index < lines.length; index += 1) {
		if (/^[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(lines[index] ?? "")) {
			return index;
		}
	}
	return -1;
}

function findNextNestedYamlKey(lines: readonly string[], start: number, end: number): number {
	for (let index = start; index < end; index += 1) {
		if (/^ {2}[A-Za-z0-9_-]+:\s*(?:.*)?$/.test(lines[index] ?? "")) {
			return index;
		}
	}
	return -1;
}

function setTopLevelYamlScalar(lines: string[], key: string, value: string): void {
	const index = findTopLevelYamlKey(lines, key);
	if (index === -1) {
		if (lines.length > 0 && lines[lines.length - 1] !== "") {
			lines.push("");
		}
		lines.push(`${key}: ${value}`);
		return;
	}

	lines[index] = `${key}: ${value}`;
}

function readTextIfExists(path: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return readFileSync(path, "utf8");
}

function defaultRuntimeCommand(cliPath: string | undefined): string {
	return cliPath ? `node ${shellQuote(cliPath)} hook hermes` : DEFAULT_RUNTIME_COMMAND;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function isPavedaHermesHookScript(content: string): boolean {
	return content.includes(PAVEDA_HERMES_BEGIN) && content.includes(PAVEDA_HERMES_END);
}

function isPavedaHermesHookLine(line: string): boolean {
	return /\bpaveda\s+hook\s+hermes\b/.test(line) || line.includes("paveda-policy.sh");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
