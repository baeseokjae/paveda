import { type OntologySchema, computeOntologySimilarity } from "../spec/ontology-convergence.js";

export type DriftSeverity = "none" | "low" | "medium" | "high";
export type DriftAction = "none" | "warn" | "block";

export interface DriftProfileAction {
	upTo: DriftSeverity;
	action: DriftAction;
}

const DRIFT_ACTIONS: Record<string, DriftProfileAction> = {
	fast: { upTo: "none", action: "none" },
	standard: { upTo: "high", action: "warn" },
	strict: { upTo: "high", action: "block" },
	release: { upTo: "high", action: "block" },
};

export interface DriftScore {
	overall: number;
	dimensions: {
		goal: number;
		constraint: number;
		ontology: number;
	};
	severity: DriftSeverity;
}

export function measureDrift(prev: unknown, curr: unknown): DriftScore {
	const previous = asRecord(prev);
	const current = asRecord(curr);
	const goal = textDrift(
		readField(previous, ["goal", "objective"]),
		readField(current, ["goal", "objective"]),
	);
	const constraint = textDrift(
		readField(previous, ["constraints", "acceptanceCriteria", "acceptance_criteria"]),
		readField(current, ["constraints", "acceptanceCriteria", "acceptance_criteria"]),
	);
	const ontology = ontologyDrift(previous?.ontology, current?.ontology);
	const overall = roundScore(0.5 * goal + 0.3 * constraint + 0.2 * ontology);
	return {
		overall,
		dimensions: { goal, constraint, ontology },
		severity: severityFor(overall),
	};
}

function textDrift(prev: unknown, curr: unknown): number {
	const left = tokenize(JSON.stringify(prev ?? ""));
	const right = tokenize(JSON.stringify(curr ?? ""));
	if (left.size === 0 && right.size === 0) {
		return 0;
	}
	const shared = [...left].filter((token) => right.has(token)).length;
	const total = new Set([...left, ...right]).size;
	return roundScore(1 - shared / Math.max(total, 1));
}

function ontologyDrift(prev: unknown, curr: unknown): number {
	const previous = parseOntology(prev);
	const current = parseOntology(curr);
	if (!previous && !current) {
		return 0;
	}
	if (!previous || !current) {
		return 1;
	}
	return roundScore(1 - computeOntologySimilarity(previous, current));
}

function parseOntology(value: unknown): OntologySchema | null {
	const record = asRecord(value);
	const entities = record?.entities;
	if (!Array.isArray(entities)) {
		return null;
	}
	return {
		entities: entities.map((entity) => {
			const entityRecord = asRecord(entity);
			const fields = Array.isArray(entityRecord?.fields) ? entityRecord.fields : [];
			return {
				name: String(entityRecord?.name ?? ""),
				fields: fields.map((field) => {
					const fieldRecord = asRecord(field);
					return {
						name: String(fieldRecord?.name ?? ""),
						type: String(fieldRecord?.type ?? ""),
						description:
							typeof fieldRecord?.description === "string" ? fieldRecord.description : undefined,
					};
				}),
			};
		}),
	};
}

function severityFor(overall: number): DriftSeverity {
	if (overall === 0) return "none";
	if (overall < 0.1) return "low";
	if (overall < 0.3) return "medium";
	return "high";
}

function readField(record: Record<string, unknown> | null, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (record && key in record) {
			return record[key];
		}
	}
	return undefined;
}

function tokenize(text: string): Set<string> {
	return new Set(text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function roundScore(value: number): number {
	return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

export function driftActionForProfile(profile: string, severity: DriftSeverity): DriftAction {
	const entry = DRIFT_ACTIONS[profile];
	if (!entry) return "none";
	const severities: DriftSeverity[] = ["none", "low", "medium", "high"];
	const severityIndex = severities.indexOf(severity);
	const upToIndex = severities.indexOf(entry.upTo);
	if (severityIndex <= upToIndex) {
		return entry.action;
	}
	return "none";
}
