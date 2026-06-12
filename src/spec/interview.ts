import type { EventRecord, EventStore } from "../store/index.js";

export type InterviewDimension =
	| "goal_clarity"
	| "constraint_clarity"
	| "success_criteria"
	| "ontology_clarity"
	| "context_clarity";

export interface InterviewRoundInput {
	sessionId: string;
	round: number;
	question: string;
	answer: string;
	dimension: InterviewDimension;
	ambiguityAfter: number;
	ts?: number;
}

export interface InterviewConvergedInput {
	sessionId: string;
	totalRounds: number;
	finalAmbiguity: number;
	dimensions: Partial<Record<InterviewDimension, number>>;
	qaHistory: Array<{ q: string; a: string }>;
	ts?: number;
}

export function recordInterviewRound(store: EventStore, input: InterviewRoundInput): EventRecord {
	assertPositiveInteger(input.round, "round");
	assertScore(input.ambiguityAfter, "ambiguityAfter");
	return store.append({
		sessionId: input.sessionId,
		ts: input.ts,
		type: "spec.interview.round",
		payload: {
			round: input.round,
			question: input.question,
			answer: input.answer,
			dimension: input.dimension,
			ambiguity_after: input.ambiguityAfter,
		},
	});
}

export function recordInterviewConverged(
	store: EventStore,
	input: InterviewConvergedInput,
): EventRecord {
	assertPositiveInteger(input.totalRounds, "totalRounds");
	assertScore(input.finalAmbiguity, "finalAmbiguity");
	for (const [dimension, value] of Object.entries(input.dimensions)) {
		assertScore(value, dimension);
	}
	return store.append({
		sessionId: input.sessionId,
		ts: input.ts,
		type: "spec.interview.converged",
		payload: {
			total_rounds: input.totalRounds,
			final_ambiguity: input.finalAmbiguity,
			dimensions: input.dimensions,
			qa_history: input.qaHistory,
		},
	});
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
}

function assertScore(value: number, label: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${label} must be between 0 and 1`);
	}
}
