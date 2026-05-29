import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";

export type ClaudeCodeHookEventName = "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop";

export interface ClaudeCodeHookPayload {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
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
		payload: normalizePayload(eventName, payload),
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
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {
		host: "claude-code",
		hookEventName: eventName,
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
