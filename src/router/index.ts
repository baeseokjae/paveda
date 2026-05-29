import type {
	RoutedSkill,
	RouterDecision,
	RouterDecisionResult,
	RouterTier,
} from "../store/index.js";

export interface RouterSignals {
	toolRetries?: number;
	verifyFailures?: number;
	ambiguityScore?: number;
	elapsedMinutes?: number;
}

export interface RouteSkillInput {
	skill?: string;
	routerEnabled?: boolean;
	ambiguityRequired?: number;
	history?: readonly RouterDecision[];
	signals?: RouterSignals;
}

export interface RouteSkillDecision {
	enabled: boolean;
	blocked: boolean;
	skill: string;
	tier: RouterTier;
	reason: string;
	ambiguityRequired?: number;
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
	if (skill !== ROUTED_SKILL) {
		return {
			enabled: false,
			blocked: false,
			skill,
			tier: "standard",
			reason: "disabled:skill",
		};
	}
	if (input.routerEnabled === false) {
		return {
			enabled: false,
			blocked: false,
			skill,
			tier: "standard",
			reason: "disabled:skill-router",
		};
	}

	const history = (input.history ?? []).filter((decision) => decision.skill === skill);
	const ambiguityScore = input.signals?.ambiguityScore;
	const ambiguityRequired = input.ambiguityRequired;
	if (
		ambiguityScore !== undefined &&
		ambiguityRequired !== undefined &&
		ambiguityScore > ambiguityRequired
	) {
		return {
			enabled: true,
			blocked: true,
			skill,
			tier: chooseBaseTier(history).tier,
			reason: "blocked:ambiguity",
			ambiguityRequired,
		};
	}

	const base = chooseBaseTier(history);
	const escalationReasons = collectEscalationReasons(input.signals ?? {});
	if (escalationReasons.length > 0) {
		return {
			enabled: true,
			blocked: false,
			skill,
			tier: upgradeTier(base.tier),
			reason: `escalate:${escalationReasons.join(",")}`,
			ambiguityRequired,
		};
	}

	return {
		enabled: true,
		blocked: false,
		skill,
		tier: base.tier,
		reason: base.reason,
		ambiguityRequired,
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
