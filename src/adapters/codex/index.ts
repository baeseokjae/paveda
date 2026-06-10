import type { LifecycleEvent } from "../../core/index.js";
import type { DispatchHookEventInput } from "../../hook-runtime/index.js";
import type { RunRecord } from "../../store/index.js";

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

	if (isRecord(payload.hostLifecycle)) {
		normalized.hostLifecycle = payload.hostLifecycle;
	}

	if (eventName === "Stop") {
		normalized.status = payload.stop_hook_active ? "active" : "completed";
	}

	return normalized;
}

export type CodexGoalNormalizedStatus = "active" | "completed" | "blocked" | "failed";

export type CodexGoalPhaseId = "intake" | "execute" | "handoff";

export interface CodexGoalLifecycleEventInput {
	runId?: string;
	objective?: string;
	acceptanceCriteria?: readonly string[];
	taskType?: string;
	profile?: string;
	cwd?: string;
	status?: unknown;
	nativeStatus?: unknown;
	plan?: unknown;
	progress?: unknown;
	message?: string;
}

export interface NormalizedCodexGoalLifecycleEvent {
	host: "codex";
	runId?: string;
	phaseId: CodexGoalPhaseId;
	eventType: string;
	normalizedStatus: CodexGoalNormalizedStatus;
	payload: Record<string, unknown>;
}

export interface CodexGoalHandoff {
	status: "native_handoff";
	primitive: "goal";
	eventType: string;
	phaseId: CodexGoalPhaseId;
	normalizedStatus: CodexGoalNormalizedStatus;
	message: string;
	payload: Record<string, unknown>;
	lifecycle: NormalizedCodexGoalLifecycleEvent;
}

export interface BuildCodexGoalHandoffInput {
	run: RunRecord;
	taskType: string;
	cwd: string;
}

export function buildCodexGoalHandoff(input: BuildCodexGoalHandoffInput): CodexGoalHandoff {
	const lifecycle = normalizeCodexGoalLifecycleEvent({
		runId: input.run.runId,
		objective: input.run.objective,
		acceptanceCriteria: readStringArray(input.run.acceptanceCriteria),
		taskType: input.taskType,
		profile: input.run.profile,
		cwd: input.cwd,
		nativeStatus: "created",
		message: "Codex native goal lifecycle handoff created.",
	});

	return {
		status: "native_handoff",
		primitive: "goal",
		eventType: lifecycle.eventType,
		phaseId: lifecycle.phaseId,
		normalizedStatus: lifecycle.normalizedStatus,
		message:
			"Codex goal handoff recorded. Continue with Codex native goal and plan execution, then record Paveda evidence before verification.",
		payload: lifecycle.payload,
		lifecycle,
	};
}

export function normalizeCodexGoalLifecycleEvent(
	input: CodexGoalLifecycleEventInput,
): NormalizedCodexGoalLifecycleEvent {
	const nativeStatus = readString(input.nativeStatus) ?? readString(input.status) ?? "active";
	const normalizedStatus = normalizeCodexGoalStatus(nativeStatus);
	const eventType = readCodexGoalEventType(nativeStatus, normalizedStatus);
	const phaseId = readCodexGoalPhaseId(eventType);
	const payload: Record<string, unknown> = {
		nativeStatus,
		normalizedStatus,
		...(input.objective ? { objective: input.objective } : {}),
		...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
		...(input.taskType ? { taskType: input.taskType } : {}),
		...(input.profile ? { profile: input.profile } : {}),
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.plan !== undefined ? { plan: input.plan } : {}),
		...(input.progress !== undefined ? { progress: input.progress } : {}),
		...(input.message ? { message: input.message } : {}),
	};

	return {
		host: "codex",
		...(input.runId ? { runId: input.runId } : {}),
		phaseId,
		eventType,
		normalizedStatus,
		payload,
	};
}

export function normalizeCodexGoalStatus(value: unknown): CodexGoalNormalizedStatus {
	const status = readString(value)?.toLowerCase().replaceAll("-", "_");
	if (
		status === "completed" ||
		status === "complete" ||
		status === "succeeded" ||
		status === "success"
	) {
		return "completed";
	}
	if (
		status === "blocked" ||
		status === "stalled" ||
		status === "cancelled" ||
		status === "canceled"
	) {
		return "blocked";
	}
	if (status === "failed" || status === "failure" || status === "error") {
		return "failed";
	}
	return "active";
}

function readCodexGoalEventType(
	nativeStatus: string,
	normalizedStatus: CodexGoalNormalizedStatus,
): string {
	const status = nativeStatus.toLowerCase().replaceAll("-", "_");
	if (status === "created" || status === "started") {
		return "codex.goal.created";
	}
	if (normalizedStatus === "completed") {
		return "codex.goal.completed";
	}
	if (normalizedStatus === "blocked") {
		return "codex.goal.blocked";
	}
	if (normalizedStatus === "failed") {
		return "codex.goal.failed";
	}
	return "codex.goal.in_progress";
}

function readCodexGoalPhaseId(eventType: string): CodexGoalPhaseId {
	if (eventType === "codex.goal.created") {
		return "intake";
	}
	if (
		eventType === "codex.goal.completed" ||
		eventType === "codex.goal.blocked" ||
		eventType === "codex.goal.failed"
	) {
		return "handoff";
	}
	return "execute";
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
