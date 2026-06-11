import type { EvidenceRecord, ScoreRecord } from "../store/index.js";
import type { PavedaTaskType, RiskSurface } from "../execution/index.js";

export interface ScoreMetricDefinition {
	id: string;
	direction: string;
	range: { min: number; max: number };
	description: string;
	inputs: string[];
	calculation: ScoreCalculation;
	requiredEvidence: string[];
	ledgerField: string;
}

export interface ScoreCalculation {
	kind: "evidence_ratio" | "threshold_check" | "weighted_inputs" | "risk_rule" | "manual_review" | "direct_gate_result";
	weights?: Record<string, number>;
}

export interface ScoreThreshold {
	metric: string;
	pass: number;
	warn?: number;
	block: number;
	repairTrigger?: number;
	overrideAllowed?: boolean;
}

export interface ScoreContext {
	evidence: readonly EvidenceRecord[];
	gates: readonly GateSummary[];
	scores: readonly ScoreRecord[];
	taskType: PavedaTaskType;
	riskSurfaces: readonly RiskSurface[];
	changedFileCount: number;
	phaseCompletionRatio: number;
}

export interface GateSummary {
	id: string;
	status: "pass" | "block" | "warn" | "not_applicable";
	evidenceKind: string;
	evidenceIds: number[];
}

export interface ScoredMetric {
	metric: string;
	value: number;
	threshold: number;
	decision: "pass" | "warn" | "block";
	kind: string;
}

export function evaluateScoreMetric(
	definition: ScoreMetricDefinition,
	threshold: ScoreThreshold,
	context: ScoreContext,
): ScoredMetric {
	const kind = definition.calculation.kind;

	let value: number;
	switch (kind) {
		case "evidence_ratio":
			value = computeEvidenceRatio(definition, context);
			break;
		case "threshold_check":
			value = computeThresholdCheck(definition, context);
			break;
		case "weighted_inputs":
			value = computeWeightedInputs(definition, context);
			break;
		case "risk_rule":
			value = computeRiskRule(context);
			break;
		case "manual_review":
			value = computeManualReview(definition, context);
			break;
		case "direct_gate_result":
			value = computeDirectGateResult(definition, context);
			break;
		default:
			value = 0;
	}

	const clampedValue = clampToRange(value, definition.range);

	const isLowerBetter = definition.direction === "lower_is_better";
	const decision = scoreDecision(clampedValue, threshold, isLowerBetter);

	return {
		metric: threshold.metric,
		value: clampedValue,
		threshold: isLowerBetter ? threshold.block : threshold.pass,
		decision,
		kind,
	};
}

function computeEvidenceRatio(
	definition: ScoreMetricDefinition,
	context: ScoreContext,
): number {
	const requiredKinds = new Set(definition.requiredEvidence);
	const relevantGates = context.gates.filter((gate) => requiredKinds.has(gate.evidenceKind));

	if (relevantGates.length === 0) {
		return 1;
	}

	const passed = relevantGates.filter((gate) => gate.status === "pass").length;
	const notApplicable = relevantGates.filter((gate) => gate.status === "not_applicable").length;
	const required = relevantGates.filter(
		(gate) => gate.status !== "warn",
	).length;

	if (required === 0) {
		return 1;
	}

	return (passed + notApplicable) / required;
}

function computeThresholdCheck(
	_definition: ScoreMetricDefinition,
	context: ScoreContext,
): number {
	const relevantEvidence = context.evidence.filter(
		(item) => item.result === "pass" || item.result === "fail",
	);
	if (relevantEvidence.length === 0) {
		return 0;
	}
	const passed = relevantEvidence.filter((item) => item.result === "pass").length;
	return passed / relevantEvidence.length;
}

function computeWeightedInputs(
	definition: ScoreMetricDefinition,
	context: ScoreContext,
): number {
	const weights = definition.calculation.weights;
	if (!weights) {
		return 0;
	}

	// "phase_events" maps to phaseCompletionRatio
	// "changes" maps to changedFileCount — normalized as: if files > 0, score improves with more completed phases
	const phaseWeight = weights.phase_events ?? 0;
	const changesWeight = weights.changes ?? 0;
	const totalWeight = phaseWeight + changesWeight;

	if (totalWeight === 0) {
		return 0;
	}

	// Phase completion: already in 0..1 range from context
	const phaseInput = context.phaseCompletionRatio;

	// Changes input: normalize so that having changes is neutral (0.5)
	// and verification evidence pushes it toward 1
	const changesInput = context.changedFileCount > 0
		? Math.min(1, 0.5 + (context.phaseCompletionRatio * 0.5))
		: 0.5;

	return (phaseWeight * phaseInput + changesWeight * changesInput) / totalWeight;
}

function computeRiskRule(context: ScoreContext): number {
	const surfaceScores: Record<string, number> = {
		auth: 1.0,
		payment: 1.0,
		data: 0.8,
		infra: 0.7,
		"public-api": 0.6,
		mixed: 0.5,
		"ui-only": 0.2,
		"docs-only": 0.1,
	};

	if (context.riskSurfaces.length === 0) {
		return 0.2;
	}

	const maxSurfaceScore = Math.max(
		...context.riskSurfaces.map(
			(surface) => surfaceScores[surface] ?? 0.4,
		),
	);

	// Evidence of adversarial and security review reduces risk
	const hasAdversarialEvidence = context.evidence.some(
		(item) =>
			(item.kind === "adversarial_review" || item.kind === "security_scan") &&
			item.result === "pass",
	);
	const hasPolicyViolations = context.gates.some((gate) => gate.status === "block");

	let risk = maxSurfaceScore;
	if (hasAdversarialEvidence) {
		risk = Math.max(0, risk - 0.3);
	}
	if (hasPolicyViolations) {
		risk = Math.min(1, risk + 0.2);
	}

	return Math.max(0, Math.min(1, risk));
}

function computeManualReview(
	definition: ScoreMetricDefinition,
	context: ScoreContext,
): number {
	const requiredKinds = new Set(definition.requiredEvidence);
	const reviewEvidence = context.evidence.filter((item) => requiredKinds.has(item.kind));

	if (reviewEvidence.length === 0) {
		// Check if there's a matching score already recorded
		const existingScore = context.scores.find(
			(score) => score.metric === definition.id,
		);
		if (existingScore && typeof existingScore.value === "number") {
			return existingScore.value;
		}
		return 0;
	}

	const passed = reviewEvidence.filter((item) => item.result === "pass").length;
	return Math.min(1, passed / requiredKinds.size);
}

function computeDirectGateResult(
	_definition: ScoreMetricDefinition,
	context: ScoreContext,
): number {
	const scoredGates = context.gates.filter((gate) => gate.status !== "warn");
	if (scoredGates.length === 0) {
		return 1;
	}
	const passed = scoredGates.filter((gate) => gate.status === "pass").length;
	const notApplicable = scoredGates.filter((gate) => gate.status === "not_applicable").length;
	return (passed + notApplicable) / scoredGates.length;
}

function scoreDecision(
	value: number,
	threshold: ScoreThreshold,
	isLowerBetter: boolean,
): "pass" | "warn" | "block" {
	if (isLowerBetter) {
		if (value <= threshold.pass) {
			return "pass";
		}
		if (threshold.warn !== undefined && value <= threshold.warn) {
			return "warn";
		}
		if (value >= threshold.block) {
			return "block";
		}
		return "block";
	}

	// higher_is_better
	if (value >= threshold.pass) {
		return "pass";
	}
	if (threshold.warn !== undefined && value >= threshold.warn) {
		return "warn";
	}
	if (value <= threshold.block) {
		return "block";
	}
	return "block";
}

function clampToRange(value: number, range: { min: number; max: number }): number {
	return Math.max(range.min, Math.min(range.max, value));
}
