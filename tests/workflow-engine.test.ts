import { describe, expect, it } from "vitest";
import {
	type PhaseGraph,
	getMaxAttempts,
	getNextPhases,
	getPhaseEvidence,
	getPhaseGraph,
	getPhaseOrder,
	getRepairTarget,
} from "../src/workflow/engine.js";

describe("workflow engine", () => {
	describe("getPhaseGraph", () => {
		it("loads the universal contract phase graph", () => {
			const graph = getPhaseGraph(process.cwd());
			expect(graph.nodes.length).toBeGreaterThan(0);
			expect(graph.entryPhase).toBe("intake");
			expect(graph.terminalPhases).toContain("handoff");
		});

		it("happy path starts at intake and ends at handoff", () => {
			const graph = getPhaseGraph(process.cwd());
			expect(graph.happyPath[0]).toBe("intake");
			expect(graph.happyPath).toContain("handoff");
		});

		it("repair edges connect semantic-adversarial-verification to repair", () => {
			const graph = getPhaseGraph(process.cwd());
			const repairEdge = graph.edges.find((e) => e.type === "repair");
			expect(repairEdge).toBeTruthy();
			expect(repairEdge?.from).toBe("semantic-adversarial-verification");
			expect(repairEdge?.to).toBe("repair");
		});

		it("nodes have required evidence", () => {
			const graph = getPhaseGraph(process.cwd());
			const node = graph.nodes.find((n) => n.id === "intake");
			expect(node).toBeTruthy();
		});
	});

	describe("getPhaseOrder", () => {
		it("returns topological order that starts at intake and preserves phase ordering", () => {
			const graph = getPhaseGraph(process.cwd());
			const order = getPhaseOrder(graph, "strict");
			expect(order[0]).toBe("intake");
			expect(order.indexOf("intake")).toBeLessThan(order.indexOf("handoff"));
			expect(order.indexOf("intake")).toBeLessThan(order.indexOf("execute"));
		});
	});

	describe("getNextPhases", () => {
		it("returns clarify after intake is completed", () => {
			const graph = getPhaseGraph(process.cwd());
			const next = getNextPhases(graph, ["intake"], [], "strict");
			expect(next.length).toBeGreaterThan(0);
		});

		it("returns repair when source phase failed", () => {
			const graph = getPhaseGraph(process.cwd());
			const next = getNextPhases(graph, [], ["semantic-adversarial-verification"], "strict");
			expect(next).toContain("repair");
		});
	});

	describe("getRepairTarget", () => {
		it("returns repair for semantic-adversarial-verification failure", () => {
			const graph = getPhaseGraph(process.cwd());
			const target = getRepairTarget(graph, "semantic-adversarial-verification", "strict");
			expect(target).toBe("repair");
		});
	});

	describe("getMaxAttempts", () => {
		it("returns 2 for repair edge", () => {
			const graph = getPhaseGraph(process.cwd());
			const max = getMaxAttempts(graph, "semantic-adversarial-verification", "repair");
			expect(max).toBeGreaterThanOrEqual(2);
		});
	});

	describe("getPhaseEvidence", () => {
		it("returns evidence requirements for intake", () => {
			const graph = getPhaseGraph(process.cwd());
			const evidence = getPhaseEvidence(graph, "intake");
			expect(evidence.length).toBeGreaterThan(0);
		});

		it("returns task-intake evidence", () => {
			const graph = getPhaseGraph(process.cwd());
			const evidence = getPhaseEvidence(graph, "intake");
			const intakeEvidence = evidence.find((e) => e.id === "task-intake");
			expect(intakeEvidence).toBeTruthy();
			expect(intakeEvidence?.kind).toBe("host_event");
		});
	});
});
