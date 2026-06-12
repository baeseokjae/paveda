export type SpecifyMode = "greenfield" | "brownfield";

export interface SpecifyClarityDimensions {
	goal_clarity: number;
	constraint_clarity: number;
	success_clarity?: number;
	ontology_clarity?: number;
	context_clarity?: number;
}

export interface AmbiguityScoreResult {
	mode: SpecifyMode;
	dimensions: Required<SpecifyClarityDimensions>;
	weights: Record<string, number>;
	clarity: number;
	ambiguity: number;
}

const GREENFIELD_WEIGHTS = { goal: 0.5, constraint: 0.3, ontology: 0.2 } as const;
const BROWNFIELD_WEIGHTS = { goal: 0.35, constraint: 0.25, success: 0.25, context: 0.15 } as const;

export function ambiguityWeights(mode: SpecifyMode): Record<string, number> {
	return mode === "brownfield" ? { ...BROWNFIELD_WEIGHTS } : { ...GREENFIELD_WEIGHTS };
}

export function scoreAmbiguity(
	mode: SpecifyMode,
	dimensions: SpecifyClarityDimensions,
): AmbiguityScoreResult {
	const normalized = normalizeDimensions(dimensions);
	const clarity =
		mode === "brownfield" ? brownfieldClarity(normalized) : greenfieldClarity(normalized);
	const roundedClarity = roundScore(clarity);
	return {
		mode,
		dimensions: normalized,
		weights: ambiguityWeights(mode),
		clarity: roundedClarity,
		ambiguity: roundScore(1 - roundedClarity),
	};
}

function greenfieldClarity(dimensions: Required<SpecifyClarityDimensions>): number {
	return (
		GREENFIELD_WEIGHTS.goal * dimensions.goal_clarity +
		GREENFIELD_WEIGHTS.constraint * dimensions.constraint_clarity +
		GREENFIELD_WEIGHTS.ontology * dimensions.ontology_clarity
	);
}

function brownfieldClarity(dimensions: Required<SpecifyClarityDimensions>): number {
	return (
		BROWNFIELD_WEIGHTS.goal * dimensions.goal_clarity +
		BROWNFIELD_WEIGHTS.constraint * dimensions.constraint_clarity +
		BROWNFIELD_WEIGHTS.success * dimensions.success_clarity +
		BROWNFIELD_WEIGHTS.context * dimensions.context_clarity
	);
}

function normalizeDimensions(
	dimensions: SpecifyClarityDimensions,
): Required<SpecifyClarityDimensions> {
	return {
		goal_clarity: clamp(dimensions.goal_clarity),
		constraint_clarity: clamp(dimensions.constraint_clarity),
		success_clarity: clamp(dimensions.success_clarity ?? dimensions.goal_clarity),
		ontology_clarity: clamp(
			dimensions.ontology_clarity ?? dimensions.success_clarity ?? dimensions.goal_clarity,
		),
		context_clarity: clamp(dimensions.context_clarity ?? dimensions.goal_clarity),
	};
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function roundScore(value: number): number {
	return Math.round(value * 1000) / 1000;
}
