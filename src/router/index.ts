import type {
	InstinctRecord,
	RoutedSkill,
	RouterDecision,
	RouterDecisionResult,
	RouterTier,
} from "../store/index.js";
import { selectProvider } from "./providers.js";

export interface RouterSignals {
	toolRetries?: number;
	verifyFailures?: number;
	ambiguityScore?: number;
	elapsedMinutes?: number;
}

export type RouteMode = "evaluate" | "interview" | "greenfield" | "brownfield";

export interface RouteSkillInput {
	skill?: string;
	routerEnabled?: boolean;
	mode?: RouteMode;
	maxRounds?: number;
	ambiguityRequired?: number;
	history?: readonly RouterDecision[];
	signals?: RouterSignals;
	preferredProvider?: string;
	allowedProviders?: readonly string[];
	failedProvider?: string;
	activeInstincts?: readonly InstinctRecord[];
}

export interface RouteSkillDecision {
	enabled: boolean;
	blocked: boolean;
	skill: string;
	mode: RouteMode;
	maxRounds?: number;
	tier: RouterTier;
	reason: string;
	ambiguityRequired?: number;
	provider: string;
	availableProviders: string[];
	providerReason: string;
}

export interface RecordRouteDecisionInput extends RouteSkillInput {
	sessionId: string;
	result?: RouterDecisionResult | null;
	ts?: number;
}

const ROUTED_SKILL = "do";
const TIER_ORDER: readonly RouterTier[] = ["frugal", "standard", "frontier"];

export function routeSkill(input: RouteSkillInput = {}): RouteSkillDecision {
	const skill = input.skill ?? ROUTED_SKILL;
	const mode = input.mode ?? "evaluate";
	if (skill !== ROUTED_SKILL) {
		return withProvider(input, {
			enabled: false,
			blocked: false,
			skill,
			mode,
			tier: "standard",
			reason: "disabled:skill",
		});
	}
	if (input.routerEnabled === false) {
		return withProvider(input, {
			enabled: false,
			blocked: false,
			skill,
			mode,
			tier: "standard",
			reason: "disabled:skill-router",
		});
	}

	const history = (input.history ?? []).filter((decision) => decision.skill === skill);
	const ambiguityScore = input.signals?.ambiguityScore;
	const ambiguityRequired = input.ambiguityRequired;
	if (
		ambiguityScore !== undefined &&
		ambiguityRequired !== undefined &&
		ambiguityScore > ambiguityRequired &&
		mode !== "interview"
	) {
		return withProvider(input, {
			enabled: true,
			blocked: true,
			skill,
			mode,
			tier: chooseBaseTier(history).tier,
			reason: "blocked:ambiguity",
			ambiguityRequired,
		});
	}

	const base = chooseBaseTier(history);
	const instinctTier = preEscalationTierFromInstincts(skill, input.activeInstincts ?? []);
	if (instinctTier) {
		return withProvider(input, {
			enabled: true,
			blocked: false,
			skill,
			mode,
			tier: maxTier(base.tier, instinctTier.tier),
			reason: `instinct:${instinctTier.reason}`,
			ambiguityRequired,
		});
	}
	const escalationReasons = collectEscalationReasons(input.signals ?? {});
	if (escalationReasons.length > 0) {
		return withProvider(input, {
			enabled: true,
			blocked: false,
			skill,
			mode,
			tier: upgradeTier(base.tier),
			reason: `escalate:${escalationReasons.join(",")}`,
			ambiguityRequired,
		});
	}

	return withProvider(input, {
		enabled: true,
		blocked: false,
		skill,
		mode,
		tier: base.tier,
		reason: mode === "interview" ? "interview:enabled" : base.reason,
		ambiguityRequired,
	});
}

function withProvider(
	input: RouteSkillInput,
	decision: Omit<RouteSkillDecision, "provider" | "availableProviders" | "providerReason">,
): RouteSkillDecision {
	const provider = selectProvider({
		tier: decision.tier,
		preferredProvider: input.preferredProvider,
		allowedProviders: input.allowedProviders,
		failedProvider: input.failedProvider,
	});
	return {
		...decision,
		...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
		provider: provider.provider,
		availableProviders: provider.availableProviders,
		providerReason: provider.reason,
	};
}

export function recordRouteDecision(
	store: {
		routerHistory(skill?: RoutedSkill, limit?: number): RouterDecision[];
		appendRouterDecision(input: {
			sessionId: string;
			skill?: RoutedSkill;
			tier: RouterTier;
			reason?: string | null;
			result?: RouterDecisionResult | null;
			ts?: number;
		}): RouterDecision;
	},
	input: RecordRouteDecisionInput,
): RouterDecision {
	const skill = input.skill ?? ROUTED_SKILL;
	if (skill !== ROUTED_SKILL) {
		throw new Error("PAL Router is only enabled for /do");
	}
	const routedSkill: RoutedSkill = skill;

	const history = input.history ?? store.routerHistory(routedSkill, 20);
	const decision = routeSkill({ ...input, history });

	return store.appendRouterDecision({
		sessionId: input.sessionId,
		skill: routedSkill,
		tier: decision.tier,
		reason: decision.reason,
		result: input.result ?? null,
		ts: input.ts,
	});
}

export function upgradeTier(tier: RouterTier): RouterTier {
	const index = TIER_ORDER.indexOf(tier);
	return TIER_ORDER[Math.min(index + 1, TIER_ORDER.length - 1)] ?? "frontier";
}

export function downgradeTier(tier: RouterTier): RouterTier {
	const index = TIER_ORDER.indexOf(tier);
	return TIER_ORDER[Math.max(index - 1, 0)] ?? "frugal";
}

function chooseBaseTier(history: readonly RouterDecision[]): { tier: RouterTier; reason: string } {
	const completed = history.filter((decision) => decision.result !== null);
	const latestSuccess = [...completed].reverse().find((decision) => decision.result === "success");
	if (!latestSuccess) {
		return { tier: "frugal", reason: "start" };
	}

	const lastThree = completed.slice(-3);
	if (
		lastThree.length === 3 &&
		lastThree.every((decision) => decision.result === "success") &&
		lastThree.every((decision) => decision.tier === latestSuccess.tier) &&
		latestSuccess.tier !== "frugal"
	) {
		return {
			tier: downgradeTier(latestSuccess.tier),
			reason: "downgrade:3-successes",
		};
	}

	return {
		tier: latestSuccess.tier,
		reason: "continue:last-success",
	};
}

function collectEscalationReasons(signals: RouterSignals): string[] {
	const reasons: string[] = [];
	if ((signals.toolRetries ?? 0) > 3) {
		reasons.push("tool-retries");
	}
	if ((signals.verifyFailures ?? 0) >= 1) {
		reasons.push("verify-failure");
	}
	if ((signals.ambiguityScore ?? 0) > 0.3) {
		reasons.push("ambiguity");
	}
	if ((signals.elapsedMinutes ?? 0) > 30) {
		reasons.push("elapsed-time");
	}

	return reasons;
}

function preEscalationTierFromInstincts(
	skill: string,
	instincts: readonly InstinctRecord[],
): { tier: RouterTier; reason: string } | null {
	const match = instincts
		.filter((instinct) => instinct.status === "active" || instinct.status === "promoted")
		.filter((instinct) => instinct.confidence >= 0.8)
		.find((instinct) => instinctAppliesToSkill(instinct, skill));
	if (!match) {
		return null;
	}
	const normalized = `${match.pattern} ${JSON.stringify(match.examples ?? {})}`.toLowerCase();
	if (normalized.includes("requires_frontier")) {
		return { tier: "frontier", reason: `requires_frontier:${match.id}` };
	}
	if (
		normalized.includes("requires_standard") ||
		normalized.includes("requires_escalation") ||
		normalized.includes("requires_escalation_review")
	) {
		return { tier: "standard", reason: `requires_standard:${match.id}` };
	}
	return null;
}

function instinctAppliesToSkill(instinct: InstinctRecord, skill: string): boolean {
	const haystack = `${instinct.pattern} ${JSON.stringify(instinct.examples ?? {})}`.toLowerCase();
	return (
		haystack.includes(`router:${skill}:`) || haystack.includes(`skill:${skill}`) || skill === "do"
	);
}

function maxTier(left: RouterTier, right: RouterTier): RouterTier {
	const leftIndex = TIER_ORDER.indexOf(left);
	const rightIndex = TIER_ORDER.indexOf(right);
	return TIER_ORDER[Math.max(leftIndex, rightIndex)] ?? right;
}
