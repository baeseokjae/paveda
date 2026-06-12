import type { PavedaConfig } from "../core/index.js";
import { loadConfig } from "../core/index.js";
import type { EventRecord, EventStore } from "../store/index.js";

export interface CostGuardResult {
	agentSpawns: number;
	elapsedMinutes: number;
	accumulatedCost: number;
	accumulatedTokens: number;
	toolCalls: number;
	warnings: string[];
	additionalContext: string | null;
	exceeded: boolean;
}

export interface ExtractedCost {
	costUsd: number;
	tokensUsed: number;
}

export interface EvaluateCostGuardOptions {
	sessionId: string;
	ts?: number;
	config?: PavedaConfig;
	payload?: unknown;
}

export function evaluateCostGuard(
	store: EventStore,
	options: EvaluateCostGuardOptions,
): CostGuardResult {
	const config = options.config ?? loadConfig();
	const ts = options.ts ?? Date.now();
	const summary = store.summarizeSession(options.sessionId);
	const events = store.replay(options.sessionId);
	const extracted = [
		...events
			.map((event) => extractCost(event.payload))
			.filter((item): item is ExtractedCost => item !== null),
		...(options.payload
			? [extractCost(options.payload)].filter((item): item is ExtractedCost => item !== null)
			: []),
	];
	const accumulatedCost = extracted.reduce((total, item) => total + item.costUsd, 0);
	const accumulatedTokens = extracted.reduce((total, item) => total + item.tokensUsed, 0);
	const agentSpawns = summary?.agentSpawns ?? 0;
	const toolCalls = summary?.toolCalls ?? countToolCalls(events);
	const startedAt = summary?.startedAt ?? ts;
	const elapsedMinutes = Math.max(0, Math.floor((ts - startedAt) / 60000));
	const warnings = buildWarnings({
		agentSpawns,
		elapsedMinutes,
		accumulatedCost,
		accumulatedTokens,
		config,
	});

	return {
		agentSpawns,
		elapsedMinutes,
		accumulatedCost,
		accumulatedTokens,
		toolCalls,
		warnings,
		additionalContext: warnings.length > 0 ? warnings.join("\n") : null,
		exceeded:
			accumulatedCost >= config.costGuardMaxUsd || accumulatedTokens >= config.costGuardMaxTokens,
	};
}

export function buildSessionCostSummary(
	store: EventStore,
	options: EvaluateCostGuardOptions,
): CostGuardResult {
	return evaluateCostGuard(store, options);
}

export function extractCost(payload: unknown): ExtractedCost | null {
	const record = asRecord(payload);
	if (!record) {
		return null;
	}
	const usage = asRecord(record.usage);
	const inputTokens = readNumber(usage?.input_tokens) ?? readNumber(usage?.inputTokens) ?? 0;
	const outputTokens = readNumber(usage?.output_tokens) ?? readNumber(usage?.outputTokens) ?? 0;
	const totalTokens =
		readNumber(usage?.total_tokens) ?? readNumber(usage?.totalTokens) ?? inputTokens + outputTokens;
	const costUsd = readNumber(record.costUsd) ?? readNumber(record.cost_usd) ?? 0;
	if (costUsd <= 0 && totalTokens <= 0) {
		return null;
	}
	return { costUsd: Math.max(0, costUsd), tokensUsed: Math.max(0, Math.floor(totalTokens)) };
}

function buildWarnings(input: {
	agentSpawns: number;
	elapsedMinutes: number;
	accumulatedCost: number;
	accumulatedTokens: number;
	config: PavedaConfig;
}): string[] {
	const warnings: string[] = [];
	const elapsedHours = Math.floor(input.elapsedMinutes / 60);

	if (input.elapsedMinutes >= input.config.costGuardMaxMinutes) {
		warnings.push(
			`Session has been running for ${elapsedHours}h ${input.elapsedMinutes % 60}m. Consider /compact or starting a fresh session.`,
		);
	}
	if (input.accumulatedCost >= input.config.costGuardMaxUsd * 0.8) {
		warnings.push(
			`Accumulated model cost is $${input.accumulatedCost.toFixed(2)} (limit $${input.config.costGuardMaxUsd.toFixed(2)}).`,
		);
	}
	if (input.accumulatedTokens >= input.config.costGuardMaxTokens * 0.8) {
		warnings.push(
			`Accumulated token usage is ${input.accumulatedTokens} tokens (limit ${input.config.costGuardMaxTokens}).`,
		);
	}
	if (
		input.agentSpawns >= input.config.costGuardAgentWarningThreshold &&
		input.agentSpawns % input.config.costGuardAgentCompactInterval === 0
	) {
		warnings.push(
			`Agent spawn count is ${input.agentSpawns}. Consider /compact before spawning more agents.`,
		);
	}
	if (
		warnings.length === 0 &&
		input.agentSpawns > 0 &&
		input.agentSpawns % input.config.costGuardAgentCompactInterval === 0
	) {
		warnings.push(
			`Agent spawn count is ${input.agentSpawns}. Consider /compact if context is getting large.`,
		);
	}
	return warnings;
}

function countToolCalls(events: readonly EventRecord[]): number {
	return events.filter((event) => event.type === "tool.execute.before").length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
