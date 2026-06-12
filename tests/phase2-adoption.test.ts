import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ontologyBoostedAmbiguityThreshold, verifyRun } from "../src/execution/index.js";
import { autoExtractInstincts, maintainInstinctLifecycle } from "../src/learning/auto-extract.js";
import { measureDrift } from "../src/policy/drift.js";
import { routeSkill } from "../src/router/index.js";
import { handleProviderError, selectProvider } from "../src/router/providers.js";
import { scoreAmbiguity } from "../src/spec/ambiguity.js";
import {
	checkOntologyConvergence,
	computeOntologySimilarity,
	recordOntologyConvergence,
} from "../src/spec/ontology-convergence.js";
import { EventStore } from "../src/store/index.js";
import { semanticSearchLedger } from "../src/store/semantic-search.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ADR 0002 phase 2", () => {
	it("detects ontology similarity and convergence", () => {
		const prev = {
			entities: [
				{ name: "Task", fields: [{ name: "title", type: "string", description: "Title" }] },
			],
		};
		const curr = {
			entities: [
				{ name: "Task", fields: [{ name: "title", type: "string", description: "Title" }] },
			],
		};
		expect(computeOntologySimilarity(prev, curr)).toBe(1);
		expect(checkOntologyConvergence([0.95, 0.97, 1])).toBe("converged");
		expect(checkOntologyConvergence([0.9, 0.92, 0.94])).toBe("stagnating");
		const store = openTempStore();
		const event = recordOntologyConvergence(store, {
			sessionId: "spec-session",
			previous: prev,
			current: curr,
			previousGenerations: [0.95, 0.97],
		});
		expect(event).toMatchObject({
			type: "spec.ontology.convergence",
			payload: { status: "converged", similarity: 1 },
		});
		store.close();
	});

	it("scores brownfield ambiguity with context clarity", () => {
		const result = scoreAmbiguity("brownfield", {
			goal_clarity: 0.85,
			constraint_clarity: 0.8,
			success_clarity: 0.75,
			context_clarity: 0.6,
		});
		expect(result.weights).toEqual({ goal: 0.35, constraint: 0.25, success: 0.25, context: 0.15 });
		expect(result.ambiguity).toBe(0.225);
	});

	it("measures weighted contract drift", () => {
		const drift = measureDrift(
			{
				goal: "build auth",
				constraints: ["safe"],
				ontology: { entities: [{ name: "User", fields: [] }] },
			},
			{
				goal: "build auth",
				constraints: ["safe", "fast"],
				ontology: { entities: [{ name: "Account", fields: [] }] },
			},
		);
		expect(drift.dimensions.goal).toBe(0);
		expect(drift.dimensions.constraint).toBeGreaterThan(0);
		expect(drift.dimensions.ontology).toBeGreaterThan(0);
		expect(drift.severity).not.toBe("none");
	});

	it("selects providers and exposes provider routing on route decisions", () => {
		expect(
			selectProvider({
				tier: "standard",
				preferredProvider: "gpt-4o",
				env: { PAVEDA_PROVIDER_POOL_STANDARD: "claude-sonnet,gpt-4o" },
			}),
		).toMatchObject({ provider: "gpt-4o" });
		expect(routeSkill({ preferredProvider: "gpt-4o-mini" })).toMatchObject({
			tier: "frugal",
			provider: "gpt-4o-mini",
		});
		expect(
			handleProviderError({
				tier: "standard",
				failedProvider: "claude-sonnet",
				env: { PAVEDA_PROVIDER_POOL_STANDARD: "claude-sonnet,gpt-4o" },
			}),
		).toMatchObject({ provider: "gpt-4o", reason: "fallback provider for standard tier" });
	});

	it("runs semantic search over EventStore events", () => {
		const store = openTempStore();
		store.append({ sessionId: "session-search", type: "session.created", ts: 1 });
		store.append({
			sessionId: "session-search",
			type: "policy.violation",
			ts: 2,
			payload: { message: "prevent destructive drop table command" },
		});
		const results = semanticSearchLedger(store, { query: "drop table", limit: 1 });
		expect(results[0]).toMatchObject({ type: "event", eventType: "policy.violation" });
		store.close();
	});

	it("auto-extracts instinct candidates from router decisions", () => {
		const store = openTempStore();
		for (let i = 0; i < 3; i += 1) {
			store.appendRouterDecision({
				sessionId: `session-${i}`,
				skill: "do",
				tier: "standard",
				result: "success",
			});
		}
		const result = autoExtractInstincts({ store, dryRun: true, minOccurrences: 3 });
		expect(result.candidates[0]).toMatchObject({
			trigger: "router:do:standard",
			outcome: "requires_same_tier",
			occurrences: 3,
			confidence: 1,
		});
		store.close();
	});

	it("maintains instinct lifecycle by expiring and reopening stale patterns", () => {
		const store = openTempStore();
		const expired = store.appendInstinct({
			scope: "project",
			pattern: "router:do:old → requires_standard",
			confidence: 0.9,
			ttlExpiresAt: 50,
			status: "active",
		});
		const reopened = store.appendInstinct({
			scope: "project",
			pattern: "router:do:flaky → requires_standard",
			confidence: 0.9,
			examples: { mismatches: 3 },
			status: "promoted",
		});
		const result = maintainInstinctLifecycle({ store, now: 100 });
		expect(result.expired.map((item) => item.id)).toContain(expired.id);
		expect(result.reopened.map((item) => item.id)).toContain(reopened.id);
		const instincts = store.listInstincts({ includeExpired: true });
		expect(instincts.find((item) => item.id === expired.id)?.status).toBe("expired");
		expect(instincts.find((item) => item.id === reopened.id)?.status).toBe("pending");
		expect(store.replay("instinct:lifecycle")[0]).toMatchObject({
			type: "instinct.lifecycle_maintained",
		});
		store.close();
	});

	it("uses ontology convergence events to boost ambiguity threshold", () => {
		const store = openTempStore();
		const run = store.createRun({ objective: "test ontology boost", profile: "standard" });
		store.append({
			sessionId: run.runId,
			type: "spec.ontology.convergence",
			payload: {
				generation: 1,
				similarity: 0.98,
				status: "converged",
				previous_generations: [0.95, 0.97, 0.98],
			},
		});
		expect(ontologyBoostedAmbiguityThreshold(store, run.runId, 0.5)).toBe(1);
		store.close();
	});

	it("filters evidence by task-id lineage via verifyRun", () => {
		const store = openTempStore();
		const now = Date.now();

		// Create a run (no context.taskType, defaults to "code")
		const run = store.createRun({ objective: "test task lineage", profile: "strict" });

		// Record evidence items with different task_ids
		const ev1 = store.recordEvidence({
			runId: run.runId,
			evidenceId: "lint-pass-1",
			kind: "lint",
			result: "pass",
			metadata: { task_id: "task-1" },
			ts: now,
		});
		const ev2 = store.recordEvidence({
			runId: run.runId,
			evidenceId: "build-pass-1",
			kind: "build",
			result: "pass",
			metadata: { task_id: "task-2" },
			ts: now + 1,
		});
		const ev3 = store.recordEvidence({
			runId: run.runId,
			evidenceId: "lint-pass-2",
			kind: "lint",
			result: "pass",
			metadata: { task_id: "task-1" },
			ts: now + 2,
		});

		// Add a plan.generated event with two tasks so verifyRun can resolve task type
		store.append({
			sessionId: run.runId,
			type: "plan.generated",
			payload: {
				tasks: [
					{ id: "task-1", title: "Lint & Test" },
					{ id: "task-2", title: "Build" },
				],
			},
			ts: now - 1,
		});

		// Verify only task-1 evidence is passed to gates
		const result = verifyRun({
			cwd: process.cwd(),
			dbPath: store.path,
			runId: run.runId,
			task: "task-1",
			write: false,
		});

		// Expect only task-1 evidence IDs in gates
		const allEvidenceIds = result.gates.flatMap((g) => g.evidenceIds);
		expect(allEvidenceIds).toContain(ev1.id);
		expect(allEvidenceIds).toContain(ev3.id);
		expect(allEvidenceIds).not.toContain(ev2.id);

		// Evidence directly via store shows all three
		const allEvidence = store.listEvidence(run.runId);
		expect(allEvidence).toHaveLength(3);

		store.close();
	});
});

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-phase2-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
