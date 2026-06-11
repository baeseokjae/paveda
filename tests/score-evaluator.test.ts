import { describe, expect, it } from "vitest";
import { evaluateScoreMetric } from "../src/score-evaluator/index.js";
import type {
	GateSummary,
	ScoreContext,
	ScoreMetricDefinition,
	ScoreThreshold,
} from "../src/score-evaluator/index.js";

const emptyContext: ScoreContext = {
	evidence: [],
	gates: [],
	scores: [],
	taskType: "code",
	riskSurfaces: [],
	changedFileCount: 0,
	phaseCompletionRatio: 0,
};

function makeDef(overrides: Partial<ScoreMetricDefinition>): ScoreMetricDefinition {
	return {
		id: "test",
		direction: "higher_is_better",
		range: { min: 0, max: 1 },
		description: "test metric",
		inputs: [],
		calculation: { kind: "direct_gate_result" },
		requiredEvidence: [],
		ledgerField: "scores.test",
		...overrides,
	};
}

function makeThreshold(overrides: Partial<ScoreThreshold>): ScoreThreshold {
	return {
		metric: "test",
		pass: 0.8,
		block: 0.5,
		...overrides,
	};
}

function makeEvidence(overrides: Partial<{ kind: string; result: "pass" | "fail" | "block" | "inconclusive" }> = {}) {
	return {
		id: 1,
		runId: "r1",
		phaseId: null as string | null,
		evidenceId: "ev1",
		kind: overrides.kind ?? "unit_test",
		result: (overrides.result ?? "pass") as "pass" | "fail" | "block" | "inconclusive",
		command: null as string | null,
		exitCode: null as number | null,
		rationale: null as string | null,
		artifactId: null as number | null,
		metadata: null as unknown,
		ts: 1000,
	};
}

describe("score evaluator", () => {
	describe("direct_gate_result", () => {
		it("returns 1 when all gates pass", () => {
			const def = makeDef({ calculation: { kind: "direct_gate_result" } });
			const threshold = makeThreshold({ metric: "verification_score", pass: 1, block: 0.99 });
			const context: ScoreContext = {
				...emptyContext,
				gates: [
					{ id: "g1", status: "pass", evidenceKind: "unit_test", evidenceIds: [1] },
					{ id: "g2", status: "pass", evidenceKind: "e2e_test", evidenceIds: [2] },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(1);
			expect(result.decision).toBe("pass");
		});

		it("returns block when gates are blocked", () => {
			const def = makeDef({ calculation: { kind: "direct_gate_result" } });
			const threshold = makeThreshold({ metric: "verification_score", pass: 1, block: 0.99 });
			const context: ScoreContext = {
				...emptyContext,
				gates: [
					{ id: "g1", status: "pass", evidenceKind: "unit_test", evidenceIds: [1] },
					{ id: "g2", status: "block", evidenceKind: "e2e_test", evidenceIds: [] },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(0.5);
			expect(result.decision).toBe("block");
		});

		it("counts not_applicable as pass-equivalent", () => {
			const def = makeDef({ calculation: { kind: "direct_gate_result" } });
			const threshold = makeThreshold({ metric: "verification_score", pass: 0.8, block: 0.5 });
			const context: ScoreContext = {
				...emptyContext,
				gates: [
					{ id: "g1", status: "pass", evidenceKind: "unit_test", evidenceIds: [1] },
					{ id: "g2", status: "not_applicable", evidenceKind: "e2e_test", evidenceIds: [] },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(1);
			expect(result.decision).toBe("pass");
		});

		it("skips warn gates in scoring", () => {
			const def = makeDef({ calculation: { kind: "direct_gate_result" } });
			const threshold = makeThreshold({ metric: "test", pass: 0.8, block: 0.5 });
			const context: ScoreContext = {
				...emptyContext,
				gates: [
					{ id: "g1", status: "pass", evidenceKind: "unit_test", evidenceIds: [1] },
					{ id: "g2", status: "warn", evidenceKind: "coverage", evidenceIds: [] },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(1);
		});
	});

	describe("evidence_ratio", () => {
		it("computes ratio of passed evidence to required evidence", () => {
			const def = makeDef({
				calculation: { kind: "evidence_ratio" },
				requiredEvidence: ["unit-test-result", "e2e-test-result"],
			});
			const threshold = makeThreshold({ metric: "test", pass: 0.8, block: 0.5 });
			const context: ScoreContext = {
				...emptyContext,
				gates: [
					{ id: "g1", status: "pass", evidenceKind: "unit-test-result", evidenceIds: [1] },
					{ id: "g2", status: "pass", evidenceKind: "e2e-test-result", evidenceIds: [2] },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(1);
		});

		it("returns 1 when no required evidence matches gates", () => {
			const def = makeDef({
				calculation: { kind: "evidence_ratio" },
				requiredEvidence: ["nonexistent"],
			});
			const threshold = makeThreshold({ metric: "test", pass: 0.8, block: 0.5 });

			const result = evaluateScoreMetric(def, threshold, emptyContext);
			expect(result.value).toBe(1);
		});
	});

	describe("risk_rule", () => {
		it("high-risk surfaces produce high risk score", () => {
			const def = makeDef({
				direction: "lower_is_better",
				calculation: { kind: "risk_rule" },
			});
			const threshold = makeThreshold({
				metric: "risk_score",
				pass: 0.2,
				warn: 0.12,
				block: 0.3,
			});
			const context: ScoreContext = {
				...emptyContext,
				riskSurfaces: ["auth", "payment"],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(1);
			expect(result.decision).toBe("block");
		});

		it("low-risk surfaces produce low risk score", () => {
			const def = makeDef({
				direction: "lower_is_better",
				calculation: { kind: "risk_rule" },
			});
			const threshold = makeThreshold({
				metric: "risk_score",
				pass: 0.2,
				warn: 0.12,
				block: 0.3,
			});
			const context: ScoreContext = {
				...emptyContext,
				riskSurfaces: ["docs-only"],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(0.1);
			expect(result.decision).toBe("pass");
		});

		it("adversarial evidence reduces risk score", () => {
			const def = makeDef({
				direction: "lower_is_better",
				calculation: { kind: "risk_rule" },
			});
			const threshold = makeThreshold({
				metric: "risk_score",
				pass: 0.2,
				block: 0.3,
			});
			const context: ScoreContext = {
				...emptyContext,
				riskSurfaces: ["auth"],
				evidence: [makeEvidence({ kind: "adversarial_review", result: "pass" })],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(0.7);
		});

		it("no risk surfaces defaults to 0.2", () => {
			const def = makeDef({ calculation: { kind: "risk_rule" } });
			const threshold = makeThreshold({ metric: "risk_score", pass: 0.2, block: 0.3 });

			const result = evaluateScoreMetric(def, threshold, emptyContext);
			expect(result.value).toBe(0.2);
			expect(result.decision).toBe("pass");
		});
	});

	describe("manual_review", () => {
		it("uses existing score when no evidence present", () => {
			const def = makeDef({
				id: "plan_quality_score",
				calculation: { kind: "manual_review" },
				requiredEvidence: ["plan-quality-review"],
			});
			const threshold = makeThreshold({ metric: "plan_quality_score", pass: 0.9, block: 0.8 });
			const context: ScoreContext = {
				...emptyContext,
				scores: [{ id: 1, runId: "r1", metric: "plan_quality_score", value: 0.95, decision: "pass", threshold: 0.9, rationale: null, ts: 1000 }],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(0.95);
			expect(result.decision).toBe("pass");
		});

		it("returns 0 when no evidence and no prior score", () => {
			const def = makeDef({
				calculation: { kind: "manual_review" },
				requiredEvidence: ["plan-quality-review"],
			});
			const threshold = makeThreshold({ metric: "plan_quality_score", pass: 0.9, block: 0.8 });

			const result = evaluateScoreMetric(def, threshold, emptyContext);
			expect(result.value).toBe(0);
			expect(result.decision).toBe("block");
		});
	});

	describe("weighted_inputs", () => {
		it("computes weighted score from phase and changes", () => {
			const def = makeDef({
				calculation: {
					kind: "weighted_inputs",
					weights: { phase_events: 0.4, changes: 0.6 },
				},
			});
			const threshold = makeThreshold({ metric: "progress_score", pass: 0.9, block: 0.75 });
			const context: ScoreContext = {
				...emptyContext,
				phaseCompletionRatio: 0.8,
				changedFileCount: 5,
			};

			const result = evaluateScoreMetric(def, threshold, context);
			// phase: 0.8*0.4=0.32, changes: 0.9*0.6=0.54 (5 files => 0.5+0.8*0.5=0.9)
			// total = 0.86/1.0 = 0.86
			expect(result.value).toBeCloseTo(0.86, 2);
		});
	});

	describe("threshold_check", () => {
		it("computes ratio of passed evidence", () => {
			const def = makeDef({ calculation: { kind: "threshold_check" } });
			const threshold = makeThreshold({ metric: "match_score", pass: 0.95, block: 0.85 });
			const context: ScoreContext = {
				...emptyContext,
				evidence: [
					makeEvidence({ kind: "semantic_review", result: "pass" }),
					{ ...makeEvidence({ kind: "semantic_review", result: "fail" }), id: 2, evidenceId: "ev2" },
				],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.value).toBe(0.5);
			expect(result.decision).toBe("block");
		});
	});

	describe("lower_is_better direction", () => {
		it("lower values pass when direction is lower_is_better", () => {
			const def = makeDef({
				direction: "lower_is_better",
				calculation: { kind: "risk_rule" },
			});
			const threshold = makeThreshold({ metric: "risk_score", pass: 0.2, block: 0.3 });
			const context: ScoreContext = {
				...emptyContext,
				riskSurfaces: ["docs-only"],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.decision).toBe("pass");
		});

		it("higher values block when direction is lower_is_better", () => {
			const def = makeDef({
				direction: "lower_is_better",
				calculation: { kind: "risk_rule" },
			});
			const threshold = makeThreshold({ metric: "risk_score", pass: 0.2, block: 0.3 });
			const context: ScoreContext = {
				...emptyContext,
				riskSurfaces: ["auth", "payment"],
			};

			const result = evaluateScoreMetric(def, threshold, context);
			expect(result.decision).toBe("block");
		});
	});
});
