import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";

export type PiHookEventName =
	| "session_start"
	| "input"
	| "before_agent_start"
	| "tool_call"
	| "tool_result"
	| "tool_execution_end"
	| "agent_end"
	| "session_shutdown";

export interface PiHookPayload {
	event_name?: string;
	eventName?: string;
	type?: string;
	session_id?: string;
	sessionId?: string;
	cwd?: string;
	paveda_run_id?: string;
	run_id?: string;
	tool_use_id?: string;
	tool_name?: string;
	toolName?: string;
	tool_input?: unknown;
	input?: unknown;
	result?: unknown;
	tool_result?: unknown;
	prompt?: string;
	message?: string;
	event?: unknown;
	[key: string]: unknown;
}

export interface NormalizedPiLifecycleEvent {
	host: "pi";
	runId?: string;
	phaseId: "intake" | "execute" | "handoff";
	eventType: string;
	normalizedStatus: "active" | "completed" | "failed";
	payload: Record<string, unknown>;
	evidence?: NormalizedPiEvidence;
}

export interface NormalizedPiEvidence {
	evidenceId: string;
	phaseId: string;
	kind: "command";
	result: "pass" | "fail" | "inconclusive";
	command?: string;
	exitCode?: number;
	rationale: string;
	metadata?: Record<string, unknown>;
}

export function fromPiHookPayload(
	payload: PiHookPayload,
	env: NodeJS.ProcessEnv = process.env,
): DispatchHookEventInput {
	const eventName = parsePiHookEventName(readEventName(payload));
	const event = isRecord(payload.event) ? payload.event : {};
	const sessionId =
		readString(payload, "session_id") ??
		readString(payload, "sessionId") ??
		readString(event, "session_id") ??
		readString(event, "sessionId") ??
		env.PAVEDA_SESSION_ID ??
		env.PI_SESSION_ID;

	if (!sessionId) {
		throw new Error("Pi hook payload is missing session_id");
	}

	const lifecycle = toLifecycleEvent(eventName);
	const matcher = getMatcher(eventName, payload, event);

	return {
		sessionId,
		lifecycle,
		matcher,
		hookName: getHookName(eventName, matcher),
		payload: normalizePayload(eventName, payload, event, matcher, env),
	};
}

export function parsePiHookEventName(value: unknown): PiHookEventName {
	if (
		value === "session_start" ||
		value === "input" ||
		value === "before_agent_start" ||
		value === "tool_call" ||
		value === "tool_result" ||
		value === "tool_execution_end" ||
		value === "agent_end" ||
		value === "session_shutdown"
	) {
		return value;
	}

	throw new Error(`Unsupported Pi hook event: ${String(value)}`);
}

export function toLifecycleEvent(eventName: PiHookEventName): LifecycleEvent {
	switch (eventName) {
		case "session_start":
			return "session.created";
		case "input":
		case "before_agent_start":
			return "prompt.submitted";
		case "tool_call":
			return "tool.execute.before";
		case "tool_result":
		case "tool_execution_end":
			return "tool.execute.after";
		case "agent_end":
		case "session_shutdown":
			return "session.completed";
	}
}

function readEventName(payload: PiHookPayload): unknown {
	const event = isRecord(payload.event) ? payload.event : {};
	return payload.event_name ?? payload.eventName ?? payload.type ?? event.event_name ?? event.type;
}

function getMatcher(
	eventName: PiHookEventName,
	payload: PiHookPayload,
	event: Record<string, unknown>,
): string {
	if (
		eventName === "tool_call" ||
		eventName === "tool_result" ||
		eventName === "tool_execution_end"
	) {
		return canonicalToolName(
			readString(payload, "tool_name") ??
				readString(payload, "toolName") ??
				readString(event, "tool_name") ??
				readString(event, "toolName") ??
				"*",
		);
	}

	return "session";
}

function getHookName(eventName: PiHookEventName, matcher: string): string {
	if (eventName === "session_start") {
		return "harness.session.context";
	}

	if (eventName === "tool_call") {
		if (matcher === "Bash") {
			return "harness.destructive.guard";
		}
		if (matcher === "Edit" || matcher === "Write" || matcher === "apply_patch") {
			return "harness.blast.check";
		}
		return "paveda.lifecycle.tool.before";
	}

	if (eventName === "tool_result" || eventName === "tool_execution_end") {
		if (matcher === "Agent") {
			return "harness.cost.guard";
		}
		if (matcher === "Bash") {
			return "harness.test.process.cleanup";
		}
		return "paveda.lifecycle.tool.after";
	}

	if (eventName === "input" || eventName === "before_agent_start") {
		return "paveda.lifecycle.prompt.submit";
	}

	return "paveda.lifecycle.session.stop";
}

function normalizePayload(
	eventName: PiHookEventName,
	payload: PiHookPayload,
	event: Record<string, unknown>,
	matcher: string,
	env: NodeJS.ProcessEnv,
): Record<string, unknown> {
	const toolInput = normalizeToolInput(matcher, readToolInput(payload, event));
	const toolResponse = readToolResponse(payload, event);
	const raw: Record<string, unknown> = {
		...payload,
		event_name: eventName,
	};

	if (matcher !== "session") {
		raw.tool_name = readString(payload, "tool_name") ?? readString(payload, "toolName") ?? matcher;
		if (toolInput !== undefined) {
			raw.tool_input = toolInput;
		}
		if (toolResponse !== undefined) {
			raw.tool_response = toolResponse;
		}
	}

	const normalized: Record<string, unknown> = {
		host: "pi",
		hookEventName: eventName,
		hostLifecycle: normalizePiLifecycleEvent(eventName, payload, event, matcher, env),
		raw,
	};

	const cwd = readString(payload, "cwd") ?? readString(event, "cwd");
	if (cwd) {
		normalized.cwd = cwd;
	}

	if (matcher !== "session") {
		normalized.tool = matcher;
	}

	const prompt = readPrompt(payload, event);
	if (prompt) {
		normalized.prompt = prompt;
	}

	return normalized;
}

export function normalizePiLifecycleEvent(
	eventName: PiHookEventName,
	payload: PiHookPayload,
	event: Record<string, unknown> = {},
	matcher = getMatcher(eventName, payload, event),
	env: NodeJS.ProcessEnv = process.env,
): NormalizedPiLifecycleEvent {
	const runId =
		readString(payload, "paveda_run_id") ??
		readString(payload, "run_id") ??
		readString(event, "paveda_run_id") ??
		readString(event, "run_id") ??
		readEnvString(env.PAVEDA_RUN_ID);
	const toolUseId =
		readString(payload, "tool_use_id") ??
		readString(payload, "toolUseId") ??
		readString(event, "tool_use_id") ??
		readString(event, "toolUseId");
	const toolInput = normalizeToolInput(matcher, readToolInput(payload, event));
	const toolResponse = readToolResponse(payload, event);
	const command = matcher === "Bash" ? readCommand(toolInput) : undefined;
	const exitCode = isPiToolAfterEvent(eventName) ? readExitCode(toolResponse) : undefined;
	const normalizedStatus = readNormalizedStatus(eventName, exitCode);
	const phaseId = readPhaseId(eventName);
	const eventType = readEventType(eventName, normalizedStatus);
	const cwd = readString(payload, "cwd") ?? readString(event, "cwd");
	const lifecyclePayload: Record<string, unknown> = {
		hookEventName: eventName,
		...(cwd ? { cwd } : {}),
		...(matcher !== "session" ? { tool: matcher } : {}),
		...(toolUseId ? { toolUseId } : {}),
		...(command ? { command } : {}),
		...(typeof exitCode === "number" ? { exitCode } : {}),
	};

	return {
		host: "pi",
		...(runId ? { runId } : {}),
		phaseId,
		eventType,
		normalizedStatus,
		payload: lifecyclePayload,
		...(isPiToolAfterEvent(eventName) && matcher === "Bash"
			? {
					evidence: {
						evidenceId: `pi-bash-${toolUseId ?? "command"}`,
						phaseId,
						kind: "command",
						result:
							typeof exitCode === "number" ? (exitCode === 0 ? "pass" : "fail") : "inconclusive",
						...(command ? { command } : {}),
						...(typeof exitCode === "number" ? { exitCode } : {}),
						rationale:
							typeof exitCode === "number"
								? "Pi Bash tool completed with an exit code."
								: "Pi Bash tool completed without a parseable exit code.",
						metadata: { hookEventName: eventName, toolUseId: toolUseId ?? null },
					},
				}
			: {}),
	};
}

function isPiToolAfterEvent(eventName: PiHookEventName): boolean {
	return eventName === "tool_result" || eventName === "tool_execution_end";
}

function readPhaseId(eventName: PiHookEventName): NormalizedPiLifecycleEvent["phaseId"] {
	if (eventName === "session_start") {
		return "intake";
	}
	if (eventName === "agent_end" || eventName === "session_shutdown") {
		return "handoff";
	}
	return "execute";
}

function readEventType(
	eventName: PiHookEventName,
	normalizedStatus: NormalizedPiLifecycleEvent["normalizedStatus"],
): string {
	switch (eventName) {
		case "session_start":
			return "pi.session.started";
		case "input":
		case "before_agent_start":
			return "pi.prompt.submitted";
		case "tool_call":
			return "pi.tool.started";
		case "tool_result":
		case "tool_execution_end":
			return normalizedStatus === "failed" ? "pi.tool.failed" : "pi.tool.completed";
		case "agent_end":
		case "session_shutdown":
			return "pi.session.completed";
	}
}

function readNormalizedStatus(
	eventName: PiHookEventName,
	exitCode: number | undefined,
): NormalizedPiLifecycleEvent["normalizedStatus"] {
	if (
		eventName === "session_start" ||
		eventName === "input" ||
		eventName === "before_agent_start" ||
		eventName === "tool_call"
	) {
		return "active";
	}
	if (typeof exitCode === "number") {
		return exitCode === 0 ? "completed" : "failed";
	}
	return "completed";
}

function canonicalToolName(toolName: string): string {
	switch (toolName) {
		case "bash":
		case "shell":
			return "Bash";
		case "write":
		case "write_file":
			return "Write";
		case "edit":
		case "edit_file":
			return "Edit";
		case "patch":
			return "apply_patch";
		case "agent":
		case "subagent":
			return "Agent";
		default:
			return toolName;
	}
}

function readToolInput(payload: PiHookPayload, event: Record<string, unknown>): unknown {
	return payload.tool_input ?? payload.input ?? event.tool_input ?? event.input;
}

function readToolResponse(payload: PiHookPayload, event: Record<string, unknown>): unknown {
	return payload.tool_result ?? payload.result ?? event.tool_result ?? event.result;
}

function normalizeToolInput(toolName: string, toolInput: unknown): unknown {
	if (!isRecord(toolInput)) {
		return toolInput;
	}

	const input = { ...toolInput };
	if ((toolName === "Edit" || toolName === "Write") && typeof input.path === "string") {
		input.file_path ??= input.path;
	}
	if ((toolName === "Edit" || toolName === "Write") && typeof input.filePath === "string") {
		input.file_path ??= input.filePath;
	}
	if (toolName === "apply_patch" && typeof input.diff === "string") {
		input.patch ??= input.diff;
	}

	return input;
}

function readPrompt(payload: PiHookPayload, event: Record<string, unknown>): string | undefined {
	return (
		readString(payload, "prompt") ??
		readString(payload, "message") ??
		readString(event, "prompt") ??
		readString(event, "message")
	);
}

function readCommand(value: unknown): string | undefined {
	return isRecord(value) ? readString(value, "command") : undefined;
}

function readExitCode(value: unknown): number | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const exitCode = value.exit_code ?? value.exitCode ?? value.code;
	return typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function readEnvString(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
