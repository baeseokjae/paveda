import type { EventStore, InstinctRecord, InstinctScope } from "../store/index.js";

export interface AutoExtractInstinctOptions {
	store: EventStore;
	scope?: InstinctScope;
	since?: number;
	minOccurrences?: number;
	minConfidence?: number;
	dryRun?: boolean;
	now?: number;
}

export interface PatternCandidate {
	pattern: string;
	trigger: string;
	outcome: string;
	occurrences: number;
	confidence: number;
	evidence: string[];
}

export interface AutoExtractInstinctResult {
	candidates: PatternCandidate[];
	inserted: InstinctRecord[];
	totalScanned: number;
	newCandidates: number;
	dryRun: boolean;
}

export interface MaintainInstinctLifecycleResult {
	expired: InstinctRecord[];
	demoted: InstinctRecord[];
	reopened: InstinctRecord[];
}

interface Aggregate {
	trigger: string;
	outcome: string;
	total: number;
	success: number;
	evidence: Set<string>;
}

export function autoExtractInstincts(
	options: AutoExtractInstinctOptions,
): AutoExtractInstinctResult {
	const minOccurrences = options.minOccurrences ?? 3;
	const minConfidence = options.minConfidence ?? 0.7;
	const aggregates = new Map<string, Aggregate>();
	const decisions = options.store.listRouterDecisions({ since: options.since, limit: 500 });
	for (const decision of decisions) {
		const trigger = `router:${decision.skill}:${decision.tier}`;
		const outcome =
			decision.result === "success" ? "requires_same_tier" : "requires_escalation_review";
		addAggregate(aggregates, trigger, outcome, decision.result === "success", decision.sessionId);
	}
	const policyDecisions = options.store.listPolicyDecisions({ since: options.since, limit: 500 });
	for (const decision of policyDecisions) {
		const trigger = `policy:${decision.ruleId}:${decision.action}`;
		const outcome = decision.enforced ? "blocks_or_requires_attention" : "allowed_or_warned";
		addAggregate(aggregates, trigger, outcome, !decision.enforced, decision.sessionId);
	}

	const candidates = [...aggregates.values()]
		.map((aggregate) => ({
			pattern: `${aggregate.trigger} → ${aggregate.outcome}`,
			trigger: aggregate.trigger,
			outcome: aggregate.outcome,
			occurrences: aggregate.total,
			confidence: roundScore(aggregate.success / Math.max(aggregate.total, 1)),
			evidence: [...aggregate.evidence].sort(),
		}))
		.filter(
			(candidate) =>
				candidate.occurrences >= minOccurrences && candidate.confidence >= minConfidence,
		)
		.sort(
			(left, right) => right.confidence - left.confidence || right.occurrences - left.occurrences,
		);

	const inserted = options.dryRun
		? []
		: candidates.map((candidate) =>
				options.store.appendInstinct({
					scope: options.scope ?? "project",
					pattern: candidate.pattern,
					evidence: candidate.evidence.join(","),
					examples: candidate,
					confidence: candidate.confidence,
					status: "pending",
					ttlExpiresAt: (options.now ?? Date.now()) + 30 * 24 * 60 * 60 * 1000,
				}),
			);
	options.store.append({
		sessionId: "instinct:auto-extract",
		type: "instinct.auto_extracted",
		payload: {
			candidates,
			total_scanned: decisions.length + policyDecisions.length,
			new_candidates: inserted.length,
			dry_run: Boolean(options.dryRun),
		},
		ts: options.now,
	});
	return {
		candidates,
		inserted,
		totalScanned: decisions.length + policyDecisions.length,
		newCandidates: inserted.length,
		dryRun: Boolean(options.dryRun),
	};
}

export function maintainInstinctLifecycle(options: {
	store: EventStore;
	scope?: InstinctScope;
	now?: number;
	demoteBelowConfidence?: number;
}): MaintainInstinctLifecycleResult {
	const now = options.now ?? Date.now();
	const demoteBelowConfidence = options.demoteBelowConfidence ?? 0.5;
	const instincts = options.store.listInstincts({
		scope: options.scope,
		includeExpired: true,
		limit: 1000,
		now: 0,
	});
	const expired: InstinctRecord[] = [];
	const demoted: InstinctRecord[] = [];
	const reopened: InstinctRecord[] = [];
	for (const instinct of instincts) {
		if (
			instinct.ttlExpiresAt !== null &&
			instinct.ttlExpiresAt <= now &&
			instinct.status !== "expired"
		) {
			const updated = options.store.updateInstinctStatus(instinct.id, "expired");
			if (updated) expired.push(updated);
			continue;
		}
		if (
			(instinct.status === "active" || instinct.status === "promoted") &&
			instinct.confidence < demoteBelowConfidence
		) {
			const updated = options.store.updateInstinctStatus(instinct.id, "pending");
			if (updated) demoted.push(updated);
			continue;
		}
		if (
			(instinct.status === "active" || instinct.status === "promoted") &&
			mismatchCount(instinct) >= 3
		) {
			const updated = options.store.updateInstinctStatus(instinct.id, "pending");
			if (updated) reopened.push(updated);
		}
	}
	options.store.append({
		sessionId: "instinct:lifecycle",
		type: "instinct.lifecycle_maintained",
		payload: {
			expired: expired.map((item) => item.id),
			demoted: demoted.map((item) => item.id),
			reopened: reopened.map((item) => item.id),
		},
		ts: now,
	});
	return { expired, demoted, reopened };
}

function addAggregate(
	aggregates: Map<string, Aggregate>,
	trigger: string,
	outcome: string,
	success: boolean,
	evidence: string,
): void {
	const key = `${trigger}:${outcome}`;
	const aggregate = aggregates.get(key) ?? {
		trigger,
		outcome,
		total: 0,
		success: 0,
		evidence: new Set<string>(),
	};
	aggregate.total += 1;
	aggregate.success += success ? 1 : 0;
	aggregate.evidence.add(evidence);
	aggregates.set(key, aggregate);
}

function roundScore(value: number): number {
	return Math.round(value * 1000) / 1000;
}

function mismatchCount(instinct: InstinctRecord): number {
	const examples = instinct.examples;
	if (typeof examples !== "object" || examples === null) {
		return 0;
	}
	const value = (examples as { mismatches?: unknown }).mismatches;
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
