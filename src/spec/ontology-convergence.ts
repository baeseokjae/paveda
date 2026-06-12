import type { EventRecord, EventStore } from "../store/index.js";

export interface OntologyField {
	name: string;
	type: string;
	description?: string;
}

export interface OntologyEntity {
	name: string;
	fields: OntologyField[];
}

export interface OntologySchema {
	entities: OntologyEntity[];
}

export type OntologyConvergenceStatus = "converged" | "stagnating" | "evolving";

export interface OntologyConvergenceResult {
	generation: number;
	similarity: number;
	status: OntologyConvergenceStatus;
	previousGenerations: number[];
}

export function computeOntologySimilarity(prev: OntologySchema, curr: OntologySchema): number {
	const prevEntities = normalizeEntities(prev);
	const currEntities = normalizeEntities(curr);
	const prevNames = new Set(prevEntities.map((entity) => entity.name));
	const currNames = new Set(currEntities.map((entity) => entity.name));
	const sharedNames = intersection(prevNames, currNames);
	const denominator = Math.max(prevNames.size, currNames.size, 1);
	const nameOverlap = sharedNames.size / denominator;

	let typeMatch = 0;
	let exactMatch = 0;
	for (const name of sharedNames) {
		const prevFields = prevEntities.find((entity) => entity.name === name)?.fields ?? [];
		const currFields = currEntities.find((entity) => entity.name === name)?.fields ?? [];
		const fieldDenominator = Math.max(prevFields.length, currFields.length, 1);
		typeMatch +=
			prevFields.filter((prevField) =>
				currFields.some(
					(currField) => currField.name === prevField.name && currField.type === prevField.type,
				),
			).length / fieldDenominator;
		exactMatch +=
			prevFields.filter((prevField) =>
				currFields.some(
					(currField) =>
						currField.name === prevField.name &&
						currField.type === prevField.type &&
						(currField.description ?? "") === (prevField.description ?? ""),
				),
			).length / fieldDenominator;
	}

	const sharedCount = Math.max(sharedNames.size, 1);
	return roundScore(
		0.5 * nameOverlap + 0.3 * (typeMatch / sharedCount) + 0.2 * (exactMatch / sharedCount),
	);
}

export function checkOntologyConvergence(
	similarities: readonly number[],
): OntologyConvergenceStatus {
	if (similarities.length < 3) {
		return "evolving";
	}
	const last3 = similarities.slice(-3) as [number, number, number];
	if (last3.every((similarity) => similarity >= 0.95)) {
		return "converged";
	}
	if (
		last3.every((similarity) => similarity >= 0.9) &&
		last3[0] <= last3[1] &&
		last3[1] <= last3[2]
	) {
		return "stagnating";
	}
	return "evolving";
}

export function evaluateOntologyConvergence(input: {
	previous: OntologySchema;
	current: OntologySchema;
	previousGenerations?: readonly number[];
}): OntologyConvergenceResult {
	const similarity = computeOntologySimilarity(input.previous, input.current);
	const previousGenerations = [...(input.previousGenerations ?? []), similarity];
	return {
		generation: previousGenerations.length,
		similarity,
		status: checkOntologyConvergence(previousGenerations),
		previousGenerations,
	};
}

export function recordOntologyConvergence(
	store: EventStore,
	input: {
		sessionId: string;
		previous: OntologySchema;
		current: OntologySchema;
		previousGenerations?: readonly number[];
		ts?: number;
	},
): EventRecord {
	const result = evaluateOntologyConvergence(input);
	return store.append({
		sessionId: input.sessionId,
		ts: input.ts,
		type: "spec.ontology.convergence",
		payload: {
			generation: result.generation,
			similarity: result.similarity,
			status: result.status,
			previous_generations: result.previousGenerations,
		},
	});
}

function normalizeEntities(schema: OntologySchema): OntologyEntity[] {
	return schema.entities.map((entity) => ({
		name: entity.name.trim().toLocaleLowerCase("en-US"),
		fields: entity.fields.map((field) => ({
			name: field.name.trim().toLocaleLowerCase("en-US"),
			type: field.type.trim().toLocaleLowerCase("en-US"),
			description: field.description?.trim(),
		})),
	}));
}

function intersection<T>(left: Set<T>, right: Set<T>): Set<T> {
	return new Set([...left].filter((value) => right.has(value)));
}

function roundScore(value: number): number {
	return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
