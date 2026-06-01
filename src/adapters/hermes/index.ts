import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";

export type HermesHookEventName =
	| "pre_tool_call"
	| "post_tool_call"
	| "pre_llm_call"
	| "post_llm_call"
	| "on_session_start"
	| "on_session_end"
	| "on_session_finalize"
	| "on_session_reset"
	| "subagent_stop"
	| "pre_gateway_dispatch"
	| "pre_approval_request"
	| "post_approval_response"
	| "transform_tool_result"
	| "transform_terminal_output"
	| "transform_llm_output";

export interface HermesHookPayload {
	hook_event_name?: string;
	session_id?: string;
	task_id?: string;
	cwd?: string;
	tool_name?: string | null;
	tool_input?: unknown;
	tool_response?: unknown;
	args?: unknown;
	params?: unknown;
	result?: unknown;
	command?: string;
	output?: string;
	exit_code?: number;
	prompt?: string;
	user_message?: string;
	message?: string;
	extra?: unknown;
	[key: string]: unknown;
}

export function fromHermesHookPayload(
	payload: HermesHookPayload,
	env: NodeJS.ProcessEnv = process.env,
): DispatchHookEventInput {
	const eventName = parseHermesHookEventName(payload.hook_event_name);
	const sessionId =
		payload.session_id ?? payload.task_id ?? env.PAVEDA_SESSION_ID ?? env.HERMES_SESSION_ID;

	if (!sessionId) {
		throw new Error("Hermes hook payload is missing session_id");
	}

	const lifecycle = toLifecycleEvent(eventName);
	const matcher = getMatcher(eventName, payload);

	return {
		sessionId,
		lifecycle,
		matcher,
		hookName: getHookName(eventName, matcher),
		payload: normalizePayload(eventName, payload, matcher),
	};
}

export function parseHermesHookEventName(value: unknown): HermesHookEventName {
	if (
		value === "pre_tool_call" ||
		value === "post_tool_call" ||
		value === "pre_llm_call" ||
		value === "post_llm_call" ||
		value === "on_session_start" ||
		value === "on_session_end" ||
		value === "on_session_finalize" ||
		value === "on_session_reset" ||
		value === "subagent_stop" ||
		value === "pre_gateway_dispatch" ||
		value === "pre_approval_request" ||
		value === "post_approval_response" ||
		value === "transform_tool_result" ||
		value === "transform_terminal_output" ||
		value === "transform_llm_output"
	) {
		return value;
	}

	throw new Error(`Unsupported Hermes hook event: ${String(value)}`);
}

export function toLifecycleEvent(eventName: HermesHookEventName): LifecycleEvent {
	switch (eventName) {
		case "on_session_start":
			return "session.created";
		case "pre_llm_call":
		case "pre_gateway_dispatch":
			return "prompt.submitted";
		case "pre_tool_call":
		case "pre_approval_request":
			return "tool.execute.before";
		case "post_tool_call":
		case "post_approval_response":
		case "subagent_stop":
		case "transform_tool_result":
		case "transform_terminal_output":
			return "tool.execute.after";
		case "on_session_end":
		case "on_session_finalize":
		case "on_session_reset":
		case "post_llm_call":
		case "transform_llm_output":
			return "session.completed";
	}
}

function getMatcher(eventName: HermesHookEventName, payload: HermesHookPayload): string {
	if (eventName === "transform_terminal_output") {
		return "Bash";
	}

	if (isToolEvent(eventName)) {
		const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "*";
		return canonicalToolName(toolName);
	}

	return "session";
}

function getHookName(eventName: HermesHookEventName, matcher: string): string {
	if (eventName === "on_session_start") {
		return "harness.session.context";
	}

	if (eventName === "pre_tool_call" || eventName === "pre_approval_request") {
		if (matcher === "Bash") {
			return "harness.destructive.guard";
		}
		if (matcher === "Edit" || matcher === "Write" || matcher === "apply_patch") {
			return "harness.blast.check";
		}
		return "paveda.lifecycle.tool.before";
	}

	if (
		eventName === "post_tool_call" ||
		eventName === "post_approval_response" ||
		eventName === "transform_terminal_output" ||
		eventName === "transform_tool_result"
	) {
		if (matcher === "Agent") {
			return "harness.cost.guard";
		}
		if (matcher === "Bash") {
			return "harness.test.process.cleanup";
		}
		return "paveda.lifecycle.tool.after";
	}

	if (eventName === "pre_llm_call" || eventName === "pre_gateway_dispatch") {
		return "paveda.lifecycle.prompt.submit";
	}

	return "paveda.lifecycle.session.stop";
}

function normalizePayload(
	eventName: HermesHookEventName,
	payload: HermesHookPayload,
	matcher: string,
): Record<string, unknown> {
	const toolInput = normalizeToolInput(matcher, readToolInput(eventName, payload), payload);
	const toolResponse = readToolResponse(eventName, payload);
	const raw: Record<string, unknown> = {
		...payload,
		hook_event_name: eventName,
	};

	if (isToolEvent(eventName)) {
		raw.tool_name = payload.tool_name ?? matcher;
		if (toolInput !== undefined) {
			raw.tool_input = toolInput;
		}
		if (toolResponse !== undefined) {
			raw.tool_response = toolResponse;
		}
	}

	const normalized: Record<string, unknown> = {
		host: "hermes",
		hookEventName: eventName,
		raw,
	};

	if (payload.cwd) {
		normalized.cwd = payload.cwd;
	}

	if (matcher !== "session") {
		normalized.tool = matcher;
	}

	const prompt = readPrompt(payload);
	if (prompt) {
		normalized.prompt = prompt;
	}

	return normalized;
}

function isToolEvent(eventName: HermesHookEventName): boolean {
	return (
		eventName === "pre_tool_call" ||
		eventName === "post_tool_call" ||
		eventName === "pre_approval_request" ||
		eventName === "post_approval_response" ||
		eventName === "transform_tool_result" ||
		eventName === "transform_terminal_output"
	);
}

function canonicalToolName(toolName: string): string {
	switch (toolName) {
		case "terminal":
		case "bash":
		case "shell":
			return "Bash";
		case "write_file":
		case "write":
			return "Write";
		case "edit_file":
		case "edit":
			return "Edit";
		case "patch":
			return "apply_patch";
		case "delegate_task":
		case "agent":
			return "Agent";
		default:
			return toolName;
	}
}

function readToolInput(eventName: HermesHookEventName, payload: HermesHookPayload): unknown {
	if (eventName === "transform_terminal_output") {
		return payload.command ? { command: payload.command } : undefined;
	}

	return payload.tool_input ?? payload.args ?? payload.params;
}

function readToolResponse(eventName: HermesHookEventName, payload: HermesHookPayload): unknown {
	if (eventName === "transform_terminal_output") {
		return {
			output: payload.output,
			exitCode: payload.exit_code,
		};
	}

	return payload.tool_response ?? payload.result;
}

function normalizeToolInput(
	toolName: string,
	toolInput: unknown,
	payload: HermesHookPayload,
): unknown {
	const input = isRecord(toolInput) ? { ...toolInput } : {};

	if (toolName === "Bash" && typeof payload.command === "string" && !input.command) {
		input.command = payload.command;
	}

	if ((toolName === "Edit" || toolName === "Write") && typeof input.path === "string") {
		input.file_path ??= input.path;
	}

	if ((toolName === "Edit" || toolName === "Write") && typeof input.filePath === "string") {
		input.file_path ??= input.filePath;
	}

	if (toolName === "apply_patch" && typeof input.diff === "string") {
		input.patch ??= input.diff;
	}

	if (Object.keys(input).length > 0) {
		return input;
	}

	return toolInput;
}

function readPrompt(payload: HermesHookPayload): string | undefined {
	if (typeof payload.prompt === "string") {
		return payload.prompt;
	}
	if (typeof payload.user_message === "string") {
		return payload.user_message;
	}
	if (typeof payload.message === "string") {
		return payload.message;
	}

	const extra = isRecord(payload.extra) ? payload.extra : {};
	const userMessage = extra.user_message;
	return typeof userMessage === "string" ? userMessage : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
