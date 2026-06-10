import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";

export type ClaudeCodeHookEventName = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";

export interface NormalizedHostLifecycleEvent {
	host: "claude-code";
	runId?: string;
	phaseId: "intake" | "execute" | "handoff";
	eventType: string;
	normalizedStatus: "active" | "completed" | "failed";
	payload: Record<string, unknown>;
	evidence?: NormalizedHostEvidence;
}

export interface NormalizedHostEvidence {
	evidenceId: string;
	phaseId: string;
	kind: "command";
	result: "pass" | "fail" | "inconclusive";
	command?: string;
	exitCode?: number;
	rationale: string;
	metadata?: Record<string, unknown>;
}

export interface ClaudeCodeHookPayload {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	paveda_run_id?: string;
	run_id?: string;
	tool_use_id?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
	stop_hook_active?: boolean;
	[key: string]: unknown;
}

export function fromClaudeCodeHookPayload(
	payload: ClaudeCodeHookPayload,
	env: NodeJS.ProcessEnv = process.env,
): DispatchHookEventInput {
	const eventName = parseClaudeCodeHookEventName(payload.hook_event_name);
	const sessionId = payload.session_id ?? env.PAVEDA_SESSION_ID ?? env.CLAUDE_SESSION_ID;

	if (!sessionId) {
		throw new Error("Claude Code hook payload is missing session_id");
	}

	const lifecycle = toLifecycleEvent(eventName);
	const matcher = getMatcher(eventName, payload);

	return {
		sessionId,
		lifecycle,
		matcher,
		hookName: getHookName(eventName, payload),
		payload: normalizePayload(eventName, payload, env),
	};
}

export function parseClaudeCodeHookEventName(value: unknown): ClaudeCodeHookEventName {
	if (
		value === "SessionStart" ||
		value === "PreToolUse" ||
		value === "PostToolUse" ||
		value === "Stop"
	) {
		return value;
	}

	throw new Error(`Unsupported Claude Code hook event: ${String(value)}`);
}

export function toLifecycleEvent(eventName: ClaudeCodeHookEventName): LifecycleEvent {
	switch (eventName) {
		case "SessionStart":
			return "session.created";
		case "PreToolUse":
			return "tool.execute.before";
		case "PostToolUse":
			return "tool.execute.after";
		case "Stop":
			return "session.completed";
	}
}

function getMatcher(eventName: ClaudeCodeHookEventName, payload: ClaudeCodeHookPayload): string {
	if (eventName === "PreToolUse" || eventName === "PostToolUse") {
		return typeof payload.tool_name === "string" ? payload.tool_name : "*";
	}

	return "session";
}

function getHookName(eventName: ClaudeCodeHookEventName, payload: ClaudeCodeHookPayload): string {
	switch (eventName) {
		case "SessionStart":
			return "harness.session.context";
		case "PreToolUse":
			if (payload.tool_name === "Bash") {
				return "harness.destructive.guard";
			}
			if (
				payload.tool_name === "Edit" ||
				payload.tool_name === "Write" ||
				payload.tool_name === "apply_patch"
			) {
				return "harness.blast.check";
			}
			return "paveda.lifecycle.tool.before";
		case "PostToolUse":
			if (payload.tool_name === "Agent") {
				return "harness.cost.guard";
			}
			if (payload.tool_name === "Bash") {
				return "harness.test.process.cleanup";
			}
			return "paveda.lifecycle.tool.after";
		case "Stop":
			return "paveda.lifecycle.session.stop";
	}
}

function normalizePayload(
	eventName: ClaudeCodeHookEventName,
	payload: ClaudeCodeHookPayload,
	env: NodeJS.ProcessEnv,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {
		host: "claude-code",
		hookEventName: eventName,
		hostLifecycle: normalizeClaudeCodeLifecycleEvent(eventName, payload, env),
		raw: payload,
	};

	if (payload.cwd) {
		normalized.cwd = payload.cwd;
	}

	if (payload.transcript_path) {
		normalized.transcriptPath = payload.transcript_path;
	}

	if (payload.tool_name) {
		normalized.tool = payload.tool_name;
	}

	if (eventName === "Stop") {
		normalized.status = payload.stop_hook_active ? "active" : "completed";
	}

	return normalized;
}

export function normalizeClaudeCodeLifecycleEvent(
	eventName: ClaudeCodeHookEventName,
	payload: ClaudeCodeHookPayload,
	env: NodeJS.ProcessEnv = process.env,
): NormalizedHostLifecycleEvent {
	const runId =
		readString(payload.paveda_run_id) ??
		readString(payload.run_id) ??
		readString(env.PAVEDA_RUN_ID);
	const toolName = readString(payload.tool_name);
	const toolUseId = readString(payload.tool_use_id);
	const command = toolName === "Bash" ? readBashCommand(payload.tool_input) : undefined;
	const exitCode = eventName === "PostToolUse" ? readExitCode(payload.tool_response) : undefined;
	const normalizedStatus = readNormalizedStatus(eventName, payload, exitCode);
	const phaseId =
		eventName === "SessionStart" ? "intake" : eventName === "Stop" ? "handoff" : "execute";
	const eventType = readEventType(eventName, normalizedStatus);
	const lifecyclePayload: Record<string, unknown> = {
		hookEventName: eventName,
		...(payload.cwd ? { cwd: payload.cwd } : {}),
		...(payload.transcript_path ? { transcriptPath: payload.transcript_path } : {}),
		...(toolName ? { tool: toolName } : {}),
		...(toolUseId ? { toolUseId } : {}),
		...(command ? { command } : {}),
		...(typeof exitCode === "number" ? { exitCode } : {}),
	};

	return {
		host: "claude-code",
		...(runId ? { runId } : {}),
		phaseId,
		eventType,
		normalizedStatus,
		payload: lifecyclePayload,
		...(eventName === "PostToolUse" && toolName === "Bash"
			? {
					evidence: {
						evidenceId: `claude-bash-${toolUseId ?? "command"}`,
						phaseId,
						kind: "command",
						result:
							typeof exitCode === "number" ? (exitCode === 0 ? "pass" : "fail") : "inconclusive",
						...(command ? { command } : {}),
						...(typeof exitCode === "number" ? { exitCode } : {}),
						rationale:
							typeof exitCode === "number"
								? "Claude Code Bash tool completed with an exit code."
								: "Claude Code Bash tool completed without a parseable exit code.",
						metadata: { hookEventName: eventName, toolUseId: toolUseId ?? null },
					},
				}
			: {}),
	};
}

function readEventType(
	eventName: ClaudeCodeHookEventName,
	normalizedStatus: NormalizedHostLifecycleEvent["normalizedStatus"],
): string {
	switch (eventName) {
		case "SessionStart":
			return "claude.session.started";
		case "PreToolUse":
			return "claude.tool.started";
		case "PostToolUse":
			return normalizedStatus === "failed" ? "claude.tool.failed" : "claude.tool.completed";
		case "Stop":
			return normalizedStatus === "active"
				? "claude.session.stop_active"
				: "claude.session.completed";
	}
}

function readNormalizedStatus(
	eventName: ClaudeCodeHookEventName,
	payload: ClaudeCodeHookPayload,
	exitCode: number | undefined,
): NormalizedHostLifecycleEvent["normalizedStatus"] {
	if (eventName === "SessionStart" || eventName === "PreToolUse") {
		return "active";
	}
	if (eventName === "Stop") {
		return payload.stop_hook_active ? "active" : "completed";
	}
	if (typeof exitCode === "number") {
		return exitCode === 0 ? "completed" : "failed";
	}
	return "completed";
}

function readBashCommand(value: unknown): string | undefined {
	return isRecord(value) ? readString(value.command) : undefined;
}

function readExitCode(value: unknown): number | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const exitCode = value.exit_code ?? value.exitCode ?? value.code;
	return typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
