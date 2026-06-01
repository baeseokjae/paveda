import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";

export type CodexHookEventName =
	| "SessionStart"
	| "UserPromptSubmit"
	| "PreToolUse"
	| "PermissionRequest"
	| "PostToolUse"
	| "Stop";

export interface CodexHookPayload {
	hook_event_name?: string;
	session_id?: string;
	turn_id?: string;
	transcript_path?: string | null;
	cwd?: string;
	model?: string;
	permission_mode?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
	prompt?: string;
	stop_hook_active?: boolean;
	last_assistant_message?: string | null;
	[key: string]: unknown;
}

export function fromCodexHookPayload(
	payload: CodexHookPayload,
	env: NodeJS.ProcessEnv = process.env,
): DispatchHookEventInput {
	const eventName = parseCodexHookEventName(payload.hook_event_name);
	const sessionId = payload.session_id ?? env.PAVEDA_SESSION_ID ?? env.CODEX_SESSION_ID;

	if (!sessionId) {
		throw new Error("Codex hook payload is missing session_id");
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

export function parseCodexHookEventName(value: unknown): CodexHookEventName {
	if (
		value === "SessionStart" ||
		value === "UserPromptSubmit" ||
		value === "PreToolUse" ||
		value === "PermissionRequest" ||
		value === "PostToolUse" ||
		value === "Stop"
	) {
		return value;
	}

	throw new Error(`Unsupported Codex hook event: ${String(value)}`);
}

export function toLifecycleEvent(eventName: CodexHookEventName): LifecycleEvent {
	switch (eventName) {
		case "SessionStart":
			return "session.created";
		case "UserPromptSubmit":
			return "prompt.submitted";
		case "PreToolUse":
		case "PermissionRequest":
			return "tool.execute.before";
		case "PostToolUse":
			return "tool.execute.after";
		case "Stop":
			return "session.completed";
	}
}

function getMatcher(eventName: CodexHookEventName, payload: CodexHookPayload): string {
	if (
		eventName === "PreToolUse" ||
		eventName === "PermissionRequest" ||
		eventName === "PostToolUse"
	) {
		return typeof payload.tool_name === "string" ? payload.tool_name : "*";
	}

	if (eventName === "SessionStart") {
		const source = payload.source;
		return typeof source === "string" ? source : "session";
	}

	return "session";
}

function getHookName(eventName: CodexHookEventName, payload: CodexHookPayload): string {
	switch (eventName) {
		case "SessionStart":
			return "harness.session.context";
		case "UserPromptSubmit":
			return "paveda.lifecycle.prompt.submit";
		case "PreToolUse":
			if (payload.tool_name === "Bash") {
				return "harness.destructive.guard";
			}
			if (payload.tool_name === "apply_patch") {
				return "harness.blast.check";
			}
			return "paveda.lifecycle.tool.before";
		case "PermissionRequest":
			return "paveda.lifecycle.permission.request";
		case "PostToolUse":
			if (payload.tool_name === "Bash") {
				return "harness.test.process.cleanup";
			}
			return "paveda.lifecycle.tool.after";
		case "Stop":
			return "paveda.lifecycle.session.stop";
	}
}

function normalizePayload(
	eventName: CodexHookEventName,
	payload: CodexHookPayload,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {
		host: "codex",
		hookEventName: eventName,
		raw: payload,
	};

	if (payload.cwd) {
		normalized.cwd = payload.cwd;
	}

	if (payload.transcript_path) {
		normalized.transcriptPath = payload.transcript_path;
	}

	if (payload.model) {
		normalized.model = payload.model;
	}

	if (payload.permission_mode) {
		normalized.permissionMode = payload.permission_mode;
	}

	if (payload.tool_name) {
		normalized.tool = payload.tool_name;
	}

	if (payload.prompt) {
		normalized.prompt = payload.prompt;
	}

	if (eventName === "Stop") {
		normalized.status = payload.stop_hook_active ? "active" : "completed";
	}

	return normalized;
}
