import type { EventRecord } from "../store/index.js";
import type { AgentEvent } from "./types.js";

export type WorkflowPhase =
	| "intake"
	| "specifying"
	| "planning"
	| "executing"
	| "verifying"
	| "handoff";

export interface WorkflowState {
	phase: WorkflowPhase;
	mutationRequiresApproval: boolean;
	mutationBlockReason: string | null;
	rootCauseEvidenceRequired: boolean;
	rootCauseEvidenceObserved: boolean;
	pendingVerification: boolean;
	lastVerificationStatus: "passed" | "failed" | "unknown" | null;
	lastVerificationCommand: string | null;
	lastPrompt: string | null;
	evidence: string[];
	updatedAt: number | null;
}

export function initialWorkflowState(): WorkflowState {
	return {
		phase: "intake",
		mutationRequiresApproval: false,
		mutationBlockReason: null,
		rootCauseEvidenceRequired: false,
		rootCauseEvidenceObserved: false,
		pendingVerification: false,
		lastVerificationStatus: null,
		lastVerificationCommand: null,
		lastPrompt: null,
		evidence: [],
		updatedAt: null,
	};
}

export function projectWorkflowState(events: readonly EventRecord[]): WorkflowState {
	const state = initialWorkflowState();

	for (const event of events) {
		applyEventToWorkflowState(state, event);
	}

	return state;
}

function applyEventToWorkflowState(state: WorkflowState, event: EventRecord): void {
	state.updatedAt = event.ts;

	if (event.type === "session.created") {
		state.phase = "intake";
		return;
	}

	if (event.type === "prompt.submitted") {
		applyPrompt(state, extractPrompt(event.payload));
		return;
	}

	if (event.type === "tool.execute.before") {
		const tool = extractTool(event.payload);
		if (isFileMutationTool(tool)) {
			state.phase = "executing";
			state.pendingVerification = true;
			state.evidence.push(`mutation:${tool.name}`);
		}
		if (isCommitOrPrTool(tool)) {
			state.phase = "handoff";
		}
		return;
	}

	if (event.type === "tool.execute.after") {
		const tool = extractTool(event.payload);
		if (isVerificationTool(tool)) {
			const verificationStatus = readVerificationStatus(tool);
			state.phase = "verifying";
			state.lastVerificationStatus = verificationStatus;
			state.lastVerificationCommand = readToolCommand(tool) ?? null;
			state.pendingVerification = verificationStatus !== "passed";
			state.evidence.push(`verification:${tool.name}:${verificationStatus}`);
		}
		if (isRootCauseEvidenceTool(tool)) {
			state.rootCauseEvidenceObserved = true;
			state.evidence.push(`root-cause-evidence:${tool.name}`);
		}
		return;
	}

	if (event.type === "session.completed") {
		state.phase = "handoff";
	}
}

function applyPrompt(state: WorkflowState, prompt: string | null): void {
	if (!prompt) {
		return;
	}

	state.lastPrompt = prompt;
	const normalized = normalizeText(prompt);

	if (isPlanOnlyPrompt(normalized)) {
		state.phase = "planning";
		state.mutationRequiresApproval = true;
		state.mutationBlockReason =
			"User asked for planning only; code or file mutation requires explicit approval.";
		return;
	}

	if (isExecutionApprovalPrompt(normalized)) {
		state.mutationRequiresApproval = false;
		state.mutationBlockReason = null;
		state.phase = "executing";
	}

	if (isRootCausePrompt(normalized)) {
		state.phase = "specifying";
		state.rootCauseEvidenceRequired = true;
		state.rootCauseEvidenceObserved = false;
	}

	if (isRootCauseEvidencePrompt(normalized)) {
		state.rootCauseEvidenceObserved = true;
		state.evidence.push("root-cause-evidence:prompt");
	}
}

function extractPrompt(payload: unknown): string | null {
	if (!isRecord(payload)) {
		return null;
	}

	if (typeof payload.prompt === "string") {
		return payload.prompt;
	}

	const raw = isRecord(payload.raw) ? payload.raw : undefined;
	return typeof raw?.prompt === "string" ? raw.prompt : null;
}

function extractTool(payload: unknown): {
	name?: string;
	input?: unknown;
	response?: unknown;
	error?: unknown;
} {
	if (!isRecord(payload)) {
		return {};
	}

	const raw = isRecord(payload.raw) ? payload.raw : undefined;
	return {
		name: typeof payload.tool === "string" ? payload.tool : readString(raw, "tool_name"),
		input: raw?.tool_input,
		response: raw?.tool_response ?? payload.toolResponse,
		error: payload.error ?? raw?.error,
	};
}

function isFileMutationTool(tool: { name?: string; input?: unknown }): boolean {
	if (tool.name === "Edit" || tool.name === "Write" || tool.name === "apply_patch") {
		return true;
	}

	if (tool.name !== "Bash") {
		return false;
	}

	const command = readString(isRecord(tool.input) ? tool.input : undefined, "command");
	return looksLikeShellFileMutation(command);
}

function isCommitOrPrTool(tool: { name?: string; input?: unknown }): boolean {
	if (tool.name === "GitHub") {
		return true;
	}

	if (tool.name !== "Bash") {
		return false;
	}

	const command = readString(isRecord(tool.input) ? tool.input : undefined, "command");
	return Boolean(command && /\b(?:git\s+commit|gh\s+pr\s+create|git\s+push)\b/.test(command));
}

function isVerificationTool(tool: { name?: string; input?: unknown }): boolean {
	if (tool.name !== "Bash") {
		return false;
	}

	const command = readToolCommand(tool);
	return Boolean(
		command &&
			/\b(?:pnpm|npm|npx|yarn)\s+(?:test|vitest|lint|typecheck|build)\b|\b(?:vitest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|tsc|biome\s+check)\b/.test(
				command,
			),
	);
}

function readVerificationStatus(tool: {
	response?: unknown;
	error?: unknown;
}): "passed" | "failed" | "unknown" {
	if (tool.error !== undefined) {
		return "failed";
	}

	const responseStatus = readStatusValue(tool.response);
	if (responseStatus !== undefined) {
		return responseStatus;
	}

	return "unknown";
}

function readStatusValue(value: unknown): "passed" | "failed" | "unknown" | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	for (const key of ["exit_code", "exitCode", "status", "code"]) {
		const candidate = value[key];
		if (typeof candidate === "number") {
			return candidate === 0 ? "passed" : "failed";
		}
		if (typeof candidate === "string") {
			const normalized = candidate.toLowerCase();
			if (normalized === "passed" || normalized === "success" || normalized === "ok") {
				return "passed";
			}
			if (normalized === "failed" || normalized === "failure" || normalized === "error") {
				return "failed";
			}
		}
	}

	const nested = value.result ?? value.output ?? value.toolResponse;
	return nested === value ? undefined : readStatusValue(nested);
}

function isRootCauseEvidenceTool(tool: { name?: string; input?: unknown }): boolean {
	if (tool.name !== "Bash") {
		return false;
	}

	const command = readString(isRecord(tool.input) ? tool.input : undefined, "command");
	return Boolean(
		command &&
			/\b(?:rg|grep|git\s+blame|git\s+log|git\s+diff|npm\s+test|pnpm\s+test|pytest|vitest)\b/.test(
				command,
			),
	);
}

function normalizeText(value: string): string {
	return value.toLowerCase();
}

function isPlanOnlyPrompt(prompt: string): boolean {
	return /(?:plan only|only plan|계획만|설계만|수정하지|구현하지|do not edit|do not modify|don't edit|don't modify)/.test(
		prompt,
	);
}

function isExecutionApprovalPrompt(prompt: string): boolean {
	return /(?:approved|approve|go ahead|proceed|implement|make the change|진행|구현|수정해|반영해)/.test(
		prompt,
	);
}

function isRootCausePrompt(prompt: string): boolean {
	return /(?:root cause|debug|diagnose|investigate|원인|왜|분석)/.test(prompt);
}

function isRootCauseEvidencePrompt(prompt: string): boolean {
	return /(?:root cause:|cause:|evidence:|원인:|근거:)/.test(prompt);
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const candidate = value?.[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function readToolCommand(tool: { input?: unknown }): string | undefined {
	return readString(isRecord(tool.input) ? tool.input : undefined, "command");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeShellFileMutation(command: string | undefined): boolean {
	return Boolean(
		command && /(?:^|\s)(?:>>?|tee(?:\s+-a)?|python\s+-c|node\s+-e)(?:\s|$)/.test(command),
	);
}

export function isWorkflowFileMutationEvent(event: AgentEvent): boolean {
	if (event.fileMutation) {
		return true;
	}

	if (
		event.tool?.name === "Edit" ||
		event.tool?.name === "Write" ||
		event.tool?.name === "apply_patch"
	) {
		return true;
	}

	if (event.tool?.name !== "Bash") {
		return false;
	}

	const command = readString(isRecord(event.tool.input) ? event.tool.input : undefined, "command");
	return looksLikeShellFileMutation(command);
}

export function isWorkflowCommitOrPrEvent(event: AgentEvent): boolean {
	if (event.tool?.name === "GitHub") {
		return true;
	}

	if (event.tool?.name !== "Bash") {
		return false;
	}

	const command = readString(isRecord(event.tool.input) ? event.tool.input : undefined, "command");
	return Boolean(command && /\b(?:git\s+commit|gh\s+pr\s+create|git\s+push)\b/.test(command));
}
