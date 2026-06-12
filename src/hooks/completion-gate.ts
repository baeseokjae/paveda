import type { HookProfile } from "../core/index.js";
import type { EventStore } from "../store/index.js";

export type CompletionGateAction = "off" | "warn" | "block";

export interface CompletionGateResult {
	verificationPassed: boolean;
	action: CompletionGateAction;
	blocked: boolean;
	message: string;
	runId: string | null;
	verificationScore: number | null;
	verificationDecision: string | null;
}

export function evaluateCompletionGate(input: {
	store: EventStore;
	sessionId: string;
	profile: HookProfile;
	payload: unknown;
}): CompletionGateResult {
	const action = actionForProfile(input.profile);
	const runId = readRunId(input.payload);
	if (action === "off") {
		return {
			verificationPassed: true,
			action,
			blocked: false,
			message: "completion verification gate disabled for minimal profile",
			runId,
			verificationScore: null,
			verificationDecision: null,
		};
	}
	const score = runId ? latestVerificationScore(input.store, runId) : null;
	const verificationPassed = score?.decision === "pass";
	return {
		verificationPassed,
		action,
		blocked: action === "block" && !verificationPassed,
		message: verificationPassed
			? "latest verification_score passed before session completion"
			: runId
				? `session completion requires passing verification for run ${runId}`
				: "session completion has no run id; cannot prove verification passed",
		runId,
		verificationScore: score?.value ?? null,
		verificationDecision: score?.decision ?? null,
	};
}

function actionForProfile(profile: HookProfile): CompletionGateAction {
	if (profile === "minimal") return "off";
	if (profile === "strict") return "block";
	return "warn";
}

function latestVerificationScore(
	store: EventStore,
	runId: string,
): { value: number; decision: string } | null {
	const scores = store
		.listScores(runId)
		.filter((score) => score.metric === "verification_score")
		.sort((left, right) => right.ts - left.ts || right.id - left.id);
	const latest = scores[0];
	return latest ? { value: latest.value, decision: latest.decision } : null;
}

function readRunId(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null || !("runId" in payload)) {
		return null;
	}
	const runId = (payload as { runId?: unknown }).runId;
	return typeof runId === "string" && runId.length > 0 ? runId : null;
}
