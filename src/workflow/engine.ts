import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PhaseNode {
	id: string;
	label: string;
	kind: string;
	required: boolean;
	requiredEvidence: EvidenceRequirement[];
	scoreImpacts: string[];
	failurePolicy: PhaseFailurePolicy;
}

export interface EvidenceRequirement {
	id: string;
	kind: string;
	requiredForProfiles: string[];
	notApplicableAllowed: boolean;
}

export interface PhaseFailurePolicy {
	onFail: string;
	missingCapability: string;
	maxAttempts: number;
}

export interface PhaseEdge {
	from: string;
	to: string;
	type: "normal" | "repair" | "block" | "terminal";
	condition?: string;
	maxAttempts?: number;
	allowedProfiles?: string[];
	requiresEvidence?: boolean;
	recordsDecision?: boolean;
}

export interface PhaseGraph {
	nodes: PhaseNode[];
	edges: PhaseEdge[];
	happyPath: string[];
	entryPhase: string;
	terminalPhases: string[];
	repairEdges: string[];
}

export interface WorkflowPhase {
	phaseId: string;
	status: "pending" | "active" | "completed" | "failed" | "blocked";
}

const FALLBACK_PHASE_GRAPH: PhaseGraph = {
	nodes: [
		{
			id: "intake",
			label: "Intake",
			kind: "intake",
			required: true,
			requiredEvidence: [],
			scoreImpacts: ["ambiguity_score"],
			failurePolicy: { onFail: "block", missingCapability: "block", maxAttempts: 1 },
		},
		{
			id: "handoff",
			label: "Handoff",
			kind: "handoff",
			required: true,
			requiredEvidence: [],
			scoreImpacts: [],
			failurePolicy: { onFail: "block", missingCapability: "block", maxAttempts: 1 },
		},
	],
	edges: [{ from: "intake", to: "handoff", type: "normal" }],
	happyPath: ["intake", "handoff"],
	entryPhase: "intake",
	terminalPhases: ["handoff"],
	repairEdges: [],
};

function loadPhaseGraph(cwd: string): PhaseGraph {
	const projectPath = join(cwd, ".paveda", "contract.json");
	const raw = JSON.parse(
		readFileSync(
			existsSync(projectPath)
				? projectPath
				: join(harnessRoot(), "contracts", "universal-contract.v1.json"),
			"utf8",
		),
	) as Record<string, unknown>;

	const graph = raw.phaseGraph;
	if (!graph || typeof graph !== "object") {
		return FALLBACK_PHASE_GRAPH;
	}

	const source = graph as Record<string, unknown>;
	return {
		nodes: parseNodes(source.nodes),
		edges: parseEdges(source.edges),
		happyPath: asStringArray(source.happyPath),
		entryPhase: typeof source.entryPhase === "string" ? source.entryPhase : "intake",
		terminalPhases: asStringArray(source.terminalPhases),
		repairEdges: asStringArray(source.repairEdges),
	};
}

function parseNodes(value: unknown): PhaseNode[] {
	if (!Array.isArray(value)) return FALLBACK_PHASE_GRAPH.nodes;
	return value
		.map((node: unknown) => {
			const n = asRecord(node);
			return {
				id: typeof n?.id === "string" ? n.id : "",
				label: typeof n?.label === "string" ? n.label : "",
				kind: typeof n?.kind === "string" ? n.kind : "",
				required: typeof n?.required === "boolean" ? n.required : true,
				requiredEvidence: parseEvidenceRequirements(n?.requiredEvidence),
				scoreImpacts: asStringArray(n?.scoreImpacts),
				failurePolicy: parseFailurePolicy(n?.failurePolicy),
			};
		})
		.filter((node) => node.id.length > 0);
}

function parseEvidenceRequirements(value: unknown): EvidenceRequirement[] {
	if (!Array.isArray(value)) return [];
	return value.map((item: unknown) => {
		const req = asRecord(item);
		return {
			id: typeof req?.id === "string" ? req.id : "",
			kind: typeof req?.kind === "string" ? req.kind : "",
			requiredForProfiles: asStringArray(req?.requiredForProfiles),
			notApplicableAllowed:
				typeof req?.notApplicableAllowed === "boolean" ? req.notApplicableAllowed : false,
		};
	});
}

function parseFailurePolicy(value: unknown): PhaseFailurePolicy {
	const policy = asRecord(value);
	return {
		onFail: typeof policy?.onFail === "string" ? policy.onFail : "block",
		missingCapability:
			typeof policy?.missingCapability === "string" ? policy.missingCapability : "block",
		maxAttempts: typeof policy?.maxAttempts === "number" ? policy.maxAttempts : 1,
	};
}

function parseEdges(value: unknown): PhaseEdge[] {
	if (!Array.isArray(value)) return FALLBACK_PHASE_GRAPH.edges;
	return value
		.map((edge: unknown) => {
			const e = asRecord(edge);
			return {
				from: typeof e?.from === "string" ? e.from : "",
				to: typeof e?.to === "string" ? e.to : "",
				type: parseEdgeType(e?.type),
				...(typeof e?.condition === "string" ? { condition: e.condition } : {}),
				...(typeof e?.maxAttempts === "number" ? { maxAttempts: e.maxAttempts } : {}),
				allowedProfiles: asStringArray(e?.allowedProfiles),
				requiresEvidence: typeof e?.requiresEvidence === "boolean" ? e.requiresEvidence : undefined,
				recordsDecision: typeof e?.recordsDecision === "boolean" ? e.recordsDecision : undefined,
			};
		})
		.filter((edge) => edge.from.length > 0 && edge.to.length > 0);
}

function parseEdgeType(value: unknown): "normal" | "repair" | "block" | "terminal" {
	if (value === "repair" || value === "block" || value === "terminal") return value;
	return "normal";
}

export function getPhaseGraph(cwd: string): PhaseGraph {
	return loadPhaseGraph(cwd);
}

export function getPhaseOrder(graph: PhaseGraph, profile: string): string[] {
	const visited = new Set<string>();
	const order: string[] = [];

	function dfs(phaseId: string, stack: Set<string>) {
		if (stack.has(phaseId)) return; // cycle guard
		if (visited.has(phaseId)) return;
		stack.add(phaseId);

		// Find outgoing edges sorted: normal first, then repair, then block
		const outgoing = graph.edges
			.filter((edge) => edge.from === phaseId)
			.filter((edge) => !edge.allowedProfiles || edge.allowedProfiles.includes(profile));

		for (const edge of outgoing) {
			dfs(edge.to, stack);
		}

		stack.delete(phaseId);
		if (!visited.has(phaseId)) {
			visited.add(phaseId);
			order.unshift(phaseId);
		}
	}

	dfs(graph.entryPhase, new Set());
	return order;
}

export function getNextPhases(
	graph: PhaseGraph,
	completedPhases: string[],
	failedPhases: string[],
	profile: string,
): string[] {
	const nextPhases: string[] = [];
	const completed = new Set(completedPhases);
	const failed = new Set(failedPhases);

	for (const edge of graph.edges) {
		if (edge.allowedProfiles && !edge.allowedProfiles.includes(profile)) continue;

		if (edge.type === "repair") {
			// Repair edge is available when source failed
			if (failed.has(edge.from) && !completed.has(edge.to)) {
				nextPhases.push(edge.to);
			}
			continue;
		}

		// Normal edges: source completed, target not done
		if (completed.has(edge.from) && !completed.has(edge.to) && !failed.has(edge.to)) {
			nextPhases.push(edge.to);
		}
	}

	return [...new Set(nextPhases)];
}

export function getRepairTarget(
	graph: PhaseGraph,
	failedPhase: string,
	profile: string,
): string | null {
	const repairEdge = graph.edges.find(
		(edge) =>
			edge.type === "repair" &&
			edge.from === failedPhase &&
			(!edge.allowedProfiles || edge.allowedProfiles.includes(profile)),
	);
	return repairEdge ? repairEdge.to : null;
}

export function getPhaseEvidence(graph: PhaseGraph, phaseId: string): EvidenceRequirement[] {
	const node = graph.nodes.find((n) => n.id === phaseId);
	return node ? node.requiredEvidence : [];
}

export function getMaxAttempts(graph: PhaseGraph, fromPhase: string, toPhase: string): number {
	const edge = graph.edges.find((e) => e.from === fromPhase && e.to === toPhase);
	return edge?.maxAttempts ?? 1;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function harnessRoot(): string {
	return join(new URL(".", import.meta.url).pathname, "..", "..", "assets", "harness");
}
