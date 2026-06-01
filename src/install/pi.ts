import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

export interface InstallPiOptions {
	extensionPath?: string;
	command?: string;
	cliPath?: string;
	write?: boolean;
	force?: boolean;
}

export interface InstallPiResult {
	extensionPath: string;
	extensionSource: string;
	written: boolean;
	changed: boolean;
	summary: PiInstallSummary;
}

export interface PiInstallSummary {
	command: string;
	events: PiHookInstallStatus[];
}

export interface PiHookInstallStatus {
	event: string;
	installed: boolean;
}

const DEFAULT_EXTENSION_PATH = ".pi/extensions/paveda-policy.ts";
const DEFAULT_HOOK_COMMAND = "paveda hook pi";
const PAVEDA_PI_BEGIN = "// BEGIN PAVEDA MANAGED PI POLICY";
const PAVEDA_PI_END = "// END PAVEDA MANAGED PI POLICY";

const PI_EVENTS = [
	"session_start",
	"before_agent_start",
	"tool_call",
	"tool_result",
	"tool_execution_end",
	"agent_end",
	"session_shutdown",
] as const;

export function installPi(options: InstallPiOptions = {}): InstallPiResult {
	const extensionPath = options.extensionPath ?? DEFAULT_EXTENSION_PATH;
	assertPiExtensionPathIsSafe(extensionPath);
	const command = options.command ?? defaultHookCommand(options.cliPath);
	const current = readTextIfExists(extensionPath);
	if (current && !isPavedaPiExtension(current) && !options.force) {
		throw new Error(
			`Pi extension already exists without a Paveda managed block: ${extensionPath}. Use --force to replace it.`,
		);
	}

	const extensionSource = renderPiPolicyExtension(command);

	if (options.write) {
		mkdirSync(dirname(extensionPath), { recursive: true });
		writeFileSync(extensionPath, extensionSource);
	}

	return {
		extensionPath,
		extensionSource,
		written: Boolean(options.write),
		changed: current !== extensionSource,
		summary: summarizePiInstall(extensionSource, command),
	};
}

export function renderPiPolicyExtension(command = DEFAULT_HOOK_COMMAND): string {
	return `${PAVEDA_PI_BEGIN}
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PAVEDA_COMMAND = ${JSON.stringify(command)};

export default function pavedaPolicy(pi: ExtensionAPI) {
\tpi.on("session_start", async (event, ctx) => {
\t\tinvokePaveda("session_start", event, ctx);
\t});

\tpi.on("before_agent_start", async (event, ctx) => {
\t\tconst response = invokePaveda("before_agent_start", event, ctx);
\t\treturn response.message ? { message: response.message } : undefined;
\t});

\tpi.on("tool_call", async (event, ctx) => {
\t\tconst response = invokePaveda("tool_call", event, ctx);
\t\tif (response.block) {
\t\t\treturn { block: true, reason: response.reason ?? "Blocked by Paveda policy" };
\t\t}
\t\treturn response.message ? { message: response.message } : undefined;
\t});

\tpi.on("tool_result", async (event, ctx) => {
\t\tinvokePaveda("tool_result", event, ctx);
\t});

\tpi.on("tool_execution_end", async (event, ctx) => {
\t\tinvokePaveda("tool_execution_end", event, ctx);
\t});

\tpi.on("agent_end", async (event, ctx) => {
\t\tinvokePaveda("agent_end", event, ctx);
\t});

\tpi.on("session_shutdown", async (event, ctx) => {
\t\tinvokePaveda("session_shutdown", event, ctx);
\t});
}

function invokePaveda(eventName: string, event: unknown, ctx: unknown): Record<string, any> {
\tconst payload = {
\t\tevent_name: eventName,
\t\t...readSessionFields(ctx),
\t\t...readToolFields(event),
\t\tevent,
\t};
\tconst result = spawnSync(PAVEDA_COMMAND, {
\t\tinput: JSON.stringify(payload),
\t\tencoding: "utf8",
\t\tshell: true,
\t\tstdio: ["pipe", "pipe", "pipe"],
\t});
\tif (result.status !== 0) {
\t\treturn {
\t\t\tblock: eventName === "tool_call",
\t\t\treason: result.stderr?.trim() || "Paveda policy command failed",
\t\t};
\t}
\tconst stdout = result.stdout.trim();
\treturn stdout ? JSON.parse(stdout) : {};
}

function readSessionFields(ctx: unknown): Record<string, unknown> {
\tconst value = isRecord(ctx) ? ctx : {};
\tconst sessionManager = isRecord(value.sessionManager) ? value.sessionManager : {};
\tconst getSessionFile = sessionManager.getSessionFile;
\tconst sessionFile = typeof getSessionFile === "function" ? getSessionFile.call(sessionManager) : undefined;
\treturn {
\t\tsession_id: process.env.PAVEDA_SESSION_ID ?? sessionFile ?? "pi-session",
\t\tcwd: typeof value.cwd === "string" ? value.cwd : process.cwd(),
\t};
}

function readToolFields(event: unknown): Record<string, unknown> {
\tconst value = isRecord(event) ? event : {};
\treturn {
\t\ttoolName: readString(value, "toolName") ?? readString(value, "tool_name"),
\t\tinput: value.input ?? value.tool_input,
\t\tresult: value.result ?? value.tool_result,
\t};
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
\tconst candidate = value[key];
\treturn typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
\treturn typeof value === "object" && value !== null && !Array.isArray(value);
}
${PAVEDA_PI_END}
`;
}

export function summarizePiInstall(
	extensionSource: string,
	command = DEFAULT_HOOK_COMMAND,
): PiInstallSummary {
	return {
		command,
		events: PI_EVENTS.map((event) => ({
			event,
			installed: extensionSource.includes(`pi.on("${event}"`),
		})),
	};
}

export function assertPiExtensionPathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Pi extension path");
}

function readTextIfExists(path: string): string | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	return readFileSync(path, "utf8");
}

function defaultHookCommand(cliPath: string | undefined): string {
	return cliPath ? `node ${shellQuote(cliPath)} hook pi` : DEFAULT_HOOK_COMMAND;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isPavedaPiExtension(content: string): boolean {
	return content.includes(PAVEDA_PI_BEGIN) && content.includes(PAVEDA_PI_END);
}
