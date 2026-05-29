import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectHookOptions {
	cwd?: string;
	hooksDir?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export interface ProjectHookExecution {
	name: string;
	path: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: string;
	response?: unknown;
}

export interface ProjectHooksResult {
	cwd: string;
	hooksDir: string;
	executions: ProjectHookExecution[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function runProjectHooks(
	payload: unknown,
	options: ProjectHookOptions = {},
): ProjectHooksResult {
	const cwd = options.cwd ?? extractCwd(payload) ?? process.cwd();
	const hooksDir = options.hooksDir ?? join(cwd, ".harness", "hooks");
	const timeoutMs = options.timeoutMs ?? parseTimeout(options.env ?? process.env);
	const rawPayload = extractRawPayload(payload) ?? payload ?? {};
	const input = JSON.stringify(rawPayload);

	if (!existsSync(hooksDir)) {
		return { cwd, hooksDir, executions: [] };
	}

	const executions = listExecutableHooks(hooksDir, rawPayload).map((path) =>
		runProjectHook(path, { cwd, input, timeoutMs, env: options.env }),
	);

	return { cwd, hooksDir, executions };
}

function listExecutableHooks(hooksDir: string, payload: unknown): string[] {
	const eventName = extractPathSegment(payload, "hook_event_name");
	const toolName = extractPathSegment(payload, "tool_name");
	const candidateDirs = [
		hooksDir,
		...(eventName ? [join(hooksDir, eventName)] : []),
		...(eventName && toolName ? [join(hooksDir, eventName, toolName)] : []),
	];

	return candidateDirs
		.filter(isDirectory)
		.flatMap((dir) => readdirSync(dir).map((entry) => join(dir, entry)))
		.filter(isExecutableFile)
		.sort((left, right) => left.localeCompare(right));
}

function runProjectHook(
	path: string,
	options: { cwd: string; input: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): ProjectHookExecution {
	const result = spawnSync(path, {
		cwd: options.cwd,
		input: options.input,
		encoding: "utf8",
		env: options.env,
		timeout: options.timeoutMs,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";

	return {
		name: basename(path),
		path,
		status: result.status,
		signal: result.signal,
		stdout,
		stderr,
		error: result.error?.message,
		response: parseHookResponse(stdout),
	};
}

function parseHookResponse(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) {
		return undefined;
	}

	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function parseTimeout(env: NodeJS.ProcessEnv): number {
	const parsed = Number(env.PAVEDA_PROJECT_HOOK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function extractCwd(payload: unknown): string | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}

	return typeof payload.cwd === "string" ? payload.cwd : undefined;
}

function extractRawPayload(payload: unknown): unknown {
	if (!isRecord(payload)) {
		return undefined;
	}

	return payload.raw;
}

function extractPathSegment(payload: unknown, key: string): string | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}

	const value = payload[key];
	if (typeof value !== "string") {
		return undefined;
	}

	return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
	if (!existsSync(path)) {
		return false;
	}

	const stat = lstatSync(path);
	return stat.isDirectory();
}

function isExecutableFile(path: string): boolean {
	const stat = lstatSync(path);
	return stat.isFile() && (stat.mode & 0o111) !== 0;
}
