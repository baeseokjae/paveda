import type { PavedaConfig } from "../core/index.js";
import { loadConfig } from "../core/index.js";
import type { EventStore } from "../store/index.js";

export interface CostGuardResult {
	agentSpawns: number;
	elapsedMinutes: number;
	warnings: string[];
	additionalContext: string | null;
}

export interface EvaluateCostGuardOptions {
	sessionId: string;
	ts?: number;
	config?: PavedaConfig;
}

export function evaluateCostGuard(
	store: EventStore,
	options: EvaluateCostGuardOptions,
): CostGuardResult {
	const config = options.config ?? loadConfig();
	const ts = options.ts ?? Date.now();
	const summary = store.summarizeSession(options.sessionId);
	const agentSpawns = summary?.agentSpawns ?? 0;
	const startedAt = summary?.startedAt ?? ts;
	const elapsedMinutes = Math.max(0, Math.floor((ts - startedAt) / 60000));
	const warnings = buildWarnings({ agentSpawns, elapsedMinutes, config });

	return {
		agentSpawns,
		elapsedMinutes,
		warnings,
		additionalContext: warnings.length > 0 ? warnings.join("\n") : null,
	};
}

function buildWarnings(input: {
	agentSpawns: number;
	elapsedMinutes: number;
	config: PavedaConfig;
}): string[] {
	const warnings: string[] = [];
	const elapsedHours = Math.floor(input.elapsedMinutes / 60);

	if (input.elapsedMinutes >= input.config.costGuardMaxMinutes) {
		warnings.push(
			`Session has been running for ${elapsedHours}h ${input.elapsedMinutes % 60}m. Consider /compact or starting a fresh session.`,
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
