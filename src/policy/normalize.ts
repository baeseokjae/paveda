import type { LifecycleEvent } from "../core/index.js";
import type { AgentEvent, AgentEventKind, AgentFileMutation } from "./types.js";

export interface NormalizeAgentEventInput {
	sessionId: string;
	lifecycle: LifecycleEvent;
	payload?: unknown;
	matcher?: string;
	ts?: number;
}

export function normalizeAgentEvent(input: NormalizeAgentEventInput): AgentEvent {
	const payload = isRecord(input.payload) ? input.payload : {};
	const raw = isRecord(payload.raw) ? payload.raw : undefined;
	const toolName = readString(payload, "tool") ?? input.matcher;
	const toolInput = raw?.tool_input;
	const toolResponse = raw?.tool_response;
	const host = readString(payload, "host") ?? "unknown";

	return {
		sessionId: input.sessionId,
		kind: lifecycleToAgentEventKind(input.lifecycle),
		host,
		ts: input.ts ?? Date.now(),
		...(readString(payload, "cwd") ? { cwd: readString(payload, "cwd") } : {}),
		lifecycle: input.lifecycle,
		...(input.matcher ? { matcher: input.matcher } : {}),
		...(toolName
			? {
					tool: {
						name: toolName,
						...(toolInput === undefined ? {} : { input: toolInput }),
						...(toolResponse === undefined ? {} : { response: toolResponse }),
					},
				}
			: {}),
		...(deriveFileMutation(toolName, toolInput) ?? {}),
		raw: input.payload ?? {},
	};
}

function lifecycleToAgentEventKind(lifecycle: LifecycleEvent): AgentEventKind {
	switch (lifecycle) {
		case "session.created":
			return "session.started";
		case "prompt.submitted":
			return "prompt.submitted";
		case "tool.execute.before":
			return "tool.requested";
		case "tool.execute.after":
			return "tool.completed";
		case "session.completed":
			return "session.stopped";
		default:
			return "tool.requested";
	}
}

function deriveFileMutation(
	toolName: string | undefined,
	toolInput: unknown,
): { fileMutation: AgentFileMutation } | undefined {
	if (toolName === "Edit" || toolName === "Write") {
		const path = readString(isRecord(toolInput) ? toolInput : {}, "file_path");
		return {
			fileMutation: {
				kind: toolName === "Edit" ? "edit" : "write",
				...(path ? { path } : {}),
				paths: path ? [path] : [],
			},
		};
	}

	if (toolName === "apply_patch") {
		const patch = readString(isRecord(toolInput) ? toolInput : {}, "patch");
		const paths = patch ? extractPatchFilePaths(patch) : [];
		return {
			fileMutation: {
				kind: "patch",
				...(paths[0] ? { path: paths[0] } : {}),
				paths,
			},
		};
	}

	return undefined;
}

function extractPatchFilePaths(patch: string): string[] {
	const paths = new Set<string>();

	for (const line of patch.split("\n")) {
		const codexMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
		if (codexMatch?.[1]) {
			paths.add(codexMatch[1].trim());
			continue;
		}

		const unifiedMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);
		if (unifiedMatch?.[1] && unifiedMatch[1] !== "/dev/null") {
			paths.add(unifiedMatch[1].trim());
		}
	}

	return [...paths];
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
