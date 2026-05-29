import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { fromClaudeCodeHookPayload } from "../adapters/claude-code/index.js";
import { type PavedaConfig, loadConfig } from "../core/index.js";
import { dispatchHookEvent } from "../hook-runtime/index.js";
import {
	type EventRecord,
	EventStore,
	type SessionSummary,
	type StoreScope,
	resolveStorePath,
} from "../store/index.js";

export interface RuntimeSmokeOptions {
	cwd?: string;
	dbPath?: string;
	sessionId?: string;
	storeScope?: StoreScope;
	ts?: number;
	env?: NodeJS.ProcessEnv;
}

export type RuntimeSmokeCheckStatus = "pass" | "fail";

export interface RuntimeSmokeCheck {
	name: string;
	status: RuntimeSmokeCheckStatus;
	message: string;
}

export interface RuntimeSmokeResult {
	ok: boolean;
	cwd: string;
	dbPath: string;
	sessionId: string;
	eventTypes: string[];
	eventCount: number;
	summary: SessionSummary | null;
	checks: RuntimeSmokeCheck[];
}

const EXPECTED_EVENT_TYPES = [
	"hook.fired",
	"config.snapshot",
	"session.created",
	"hook.fired",
	"tool.execute.before",
	"destructive.guard.evaluated",
	"tooling.enforce.evaluated",
	"hook.fired",
	"session.completed",
] as const;

export function runRuntimeSmoke(options: RuntimeSmokeOptions = {}): RuntimeSmokeResult {
	const cwd = options.cwd ?? process.cwd();
	if (!isDirectory(cwd)) {
		throw new Error(`Runtime smoke cwd is not a directory: ${cwd}`);
	}

	const env = options.env ?? process.env;
	const dbPath = resolveRuntimeSmokeStorePath(options, cwd, env);
	const sessionId = options.sessionId ?? `runtime-smoke-${randomUUID()}`;
	const ts = options.ts ?? Date.now();
	const config = buildRuntimeSmokeConfig(env);
	const store = new EventStore(dbPath);

	try {
		const sessionStart = dispatchHookEvent(store, {
			...fromClaudeCodeHookPayload(
				{
					hook_event_name: "SessionStart",
					session_id: sessionId,
					cwd,
				},
				env,
			),
			ts,
			config,
			projectHooks: false,
		});
		const preToolUse = dispatchHookEvent(store, {
			...fromClaudeCodeHookPayload(
				{
					hook_event_name: "PreToolUse",
					session_id: sessionId,
					cwd,
					tool_name: "Bash",
					tool_input: { command: "pnpm --version" },
				},
				env,
			),
			ts: ts + 1,
			config,
			projectHooks: false,
		});
		const stop = dispatchHookEvent(store, {
			...fromClaudeCodeHookPayload(
				{
					hook_event_name: "Stop",
					session_id: sessionId,
					stop_hook_active: false,
				},
				env,
			),
			ts: ts + 2,
			config,
			projectHooks: false,
		});
		const events = store.replay(sessionId);
		const summary = store.summarizeSession(sessionId);
		const eventTypes = events.map((event) => event.type);
		const checks = buildChecks({
			sessionStart: sessionStart.dispatched,
			preToolUse: preToolUse.dispatched,
			stop: stop.dispatched,
			events,
			summary,
		});

		return {
			ok: checks.every((check) => check.status === "pass"),
			cwd,
			dbPath,
			sessionId,
			eventTypes,
			eventCount: events.length,
			summary,
			checks,
		};
	} finally {
		store.close();
	}
}

function resolveRuntimeSmokeStorePath(
	options: RuntimeSmokeOptions,
	cwd: string,
	env: NodeJS.ProcessEnv,
): string {
	if (options.dbPath) {
		return options.dbPath;
	}

	return resolveStorePath(options.storeScope ?? "project", cwd, env);
}

function buildRuntimeSmokeConfig(env: NodeJS.ProcessEnv): PavedaConfig {
	return {
		...loadConfig(env),
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: false,
	};
}

function buildChecks(input: {
	sessionStart: boolean;
	preToolUse: boolean;
	stop: boolean;
	events: EventRecord[];
	summary: SessionSummary | null;
}): RuntimeSmokeCheck[] {
	const eventTypes = input.events.map((event) => event.type);
	return [
		{
			name: "session-start-dispatch",
			status: input.sessionStart ? "pass" : "fail",
			message: input.sessionStart
				? "SessionStart payload dispatched."
				: "SessionStart payload was not dispatched.",
		},
		{
			name: "pre-tool-use-dispatch",
			status: input.preToolUse ? "pass" : "fail",
			message: input.preToolUse
				? "PreToolUse payload dispatched."
				: "PreToolUse payload was not dispatched.",
		},
		{
			name: "stop-dispatch",
			status: input.stop ? "pass" : "fail",
			message: input.stop ? "Stop payload dispatched." : "Stop payload was not dispatched.",
		},
		{
			name: "event-replay",
			status: hasExpectedEventTypes(eventTypes) ? "pass" : "fail",
			message: hasExpectedEventTypes(eventTypes)
				? "Lifecycle events replay from EventStore."
				: `Lifecycle event replay mismatch: ${eventTypes.join(", ")}.`,
		},
		{
			name: "session-summary",
			status:
				input.summary?.status === "completed" && input.summary.toolCalls === 1 ? "pass" : "fail",
			message:
				input.summary?.status === "completed" && input.summary.toolCalls === 1
					? "Completed session summary was materialized."
					: "Completed session summary was not materialized.",
		},
	];
}

function hasExpectedEventTypes(actual: string[]): boolean {
	return EXPECTED_EVENT_TYPES.every((type, index) => actual[index] === type);
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}
