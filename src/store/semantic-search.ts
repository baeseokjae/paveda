import type { EventRecord, EventStore } from "./index.js";

export interface SemanticSearchOptions {
	query: string;
	runId?: string;
	limit?: number;
	since?: number;
}

export interface SemanticSearchResult {
	type: "event" | "evidence" | "decision" | "policy_violation";
	runId: string;
	refId: number;
	snippet: string;
	score: number;
	eventType?: string;
	sessionId?: string;
}

export function semanticSearchLedger(
	store: EventStore,
	options: SemanticSearchOptions,
): SemanticSearchResult[] {
	const limit = options.limit ?? 10;
	const queryVector = embedText(options.query);
	const events = collectEvents(store, options);
	const semantic = events
		.map((event) => ({ event, score: cosine(queryVector, embedText(eventText(event))) }))
		.filter((item) => item.score > 0)
		.sort((left, right) => right.score - left.score)
		.slice(0, limit)
		.map(({ event, score }) => ({
			type: "event" as const,
			runId: event.sessionId,
			refId: event.id,
			snippet: eventText(event).slice(0, 240),
			score: roundScore(score),
			eventType: event.type,
			sessionId: event.sessionId,
		}));
	return semantic.length > 0 ? semantic : keywordFallback(store, options, limit);
}

function collectEvents(store: EventStore, options: SemanticSearchOptions): EventRecord[] {
	const sessions = options.runId
		? [{ id: options.runId }]
		: store.listSessions({ since: options.since }).map((session) => ({ id: session.id }));
	return sessions.flatMap((session) => store.replay(session.id, { since: options.since }));
}

function keywordFallback(
	store: EventStore,
	options: SemanticSearchOptions,
	limit: number,
): SemanticSearchResult[] {
	return store
		.searchLedger({ query: options.query, runId: options.runId, limit })
		.map((result) => ({ ...result, score: 0 }));
}

function eventText(event: EventRecord): string {
	return JSON.stringify({ type: event.type, payload: event.payload });
}

function embedText(text: string): Map<string, number> {
	const tokens = text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [];
	const vector = new Map<string, number>();
	for (const token of tokens) {
		vector.set(token, (vector.get(token) ?? 0) + 1);
	}
	return vector;
}

function cosine(left: Map<string, number>, right: Map<string, number>): number {
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (const value of left.values()) {
		leftNorm += value * value;
	}
	for (const value of right.values()) {
		rightNorm += value * value;
	}
	for (const [token, value] of left.entries()) {
		dot += value * (right.get(token) ?? 0);
	}
	if (leftNorm === 0 || rightNorm === 0) {
		return 0;
	}
	return dot / Math.sqrt(leftNorm * rightNorm);
}

function roundScore(value: number): number {
	return Math.round(value * 1000) / 1000;
}
