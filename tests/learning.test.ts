import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	explainLearningPattern,
	promoteLearningPattern,
	proposeLearningPattern,
	retireLearningPattern,
} from "../src/learning/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("learning lifecycle", () => {
	it("promotes only validated, audited, approved project-scope patterns", () => {
		const { cwd, store, runId, evidenceId } = learningFixture();
		try {
			const candidate = proposeLearningPattern({
				store,
				runId,
				scope: "project",
				state: "candidate",
				pattern: "Use package smoke to guard host handoff regressions.",
				confidence: 0.95,
				evidenceId,
				metadata: { successfulRuns: 3, evidenceAudit: "pass" },
			});
			expect(() =>
				promoteLearningPattern({
					store,
					cwd,
					id: candidate.id,
					approvedBy: "tester",
					write: true,
				}),
			).toThrow("pattern must be validated");

			const validated = proposeLearningPattern({
				store,
				runId,
				scope: "project",
				state: "validated",
				pattern: "Record package smoke evidence before accepting host handoff changes.",
				confidence: 0.95,
				evidenceId,
				metadata: { successfulRuns: 3, evidenceAudit: "pass" },
			});
			const promoted = promoteLearningPattern({
				store,
				cwd,
				id: validated.id,
				approvedBy: "tester",
				write: true,
				now: 2_000,
			});

			expect(promoted.pattern).toMatchObject({
				id: validated.id,
				state: "promoted",
				promotedAt: 2_000,
			});
			expect(promoted.knowledgeFile).toMatchObject({
				status: "written",
				patternCount: 1,
			});
			const filePath = join(cwd, ".paveda", "learning", "patterns.json");
			expect(existsSync(filePath)).toBe(true);
			const file = JSON.parse(readFileSync(filePath, "utf8")) as {
				patterns: Array<{ id: number; approvedBy: string }>;
			};
			expect(file.patterns).toEqual([
				expect.objectContaining({ id: validated.id, approvedBy: "tester" }),
			]);

			const explained = explainLearningPattern({ store, cwd, id: validated.id });
			expect(explained.eligibility.eligible).toBe(false);
			expect(explained.eligibility.failures).toContain(
				"pattern must be validated before promotion",
			);
		} finally {
			store.close();
		}
	});

	it("blocks learning patterns that try to relax required gates", () => {
		const { store, runId, evidenceId } = learningFixture();
		try {
			expect(() =>
				proposeLearningPattern({
					store,
					runId,
					scope: "project",
					state: "validated",
					pattern: "Skip e2e gate for code tasks when confidence is high.",
					confidence: 0.95,
					evidenceId,
					metadata: { successfulRuns: 3, evidenceAudit: "pass" },
				}),
			).toThrow("learning patterns cannot relax gates");
		} finally {
			store.close();
		}
	});

	it("retires promoted project learning and rewrites promoted knowledge", () => {
		const { cwd, store, runId, evidenceId } = learningFixture();
		try {
			const validated = proposeLearningPattern({
				store,
				runId,
				scope: "project",
				state: "validated",
				pattern: "Keep Codex goal handoff checks in package smoke.",
				confidence: 0.95,
				evidenceId,
				metadata: { manualValidation: true, evidenceAuditPassed: true },
			});
			promoteLearningPattern({ store, cwd, id: validated.id, approvedBy: "tester", write: true });
			const retired = retireLearningPattern({
				store,
				cwd,
				id: validated.id,
				reason: "Superseded by conformance fixture.",
				write: true,
				now: 3_000,
			});

			expect(retired.pattern).toMatchObject({
				id: validated.id,
				state: "retired",
				retiredAt: 3_000,
			});
			const file = JSON.parse(
				readFileSync(join(cwd, ".paveda", "learning", "patterns.json"), "utf8"),
			) as { patterns: unknown[] };
			expect(file.patterns).toEqual([]);
		} finally {
			store.close();
		}
	});
});

function learningFixture(): {
	cwd: string;
	store: EventStore;
	runId: string;
	evidenceId: number;
} {
	const cwd = mkdtempSync(join(tmpdir(), "paveda-learning-"));
	tempDirs.push(cwd);
	const store = new EventStore(join(cwd, ".paveda", "ledger", "paveda.db"));
	const run = store.createRun({
		objective: "Exercise learning lifecycle",
		acceptanceCriteria: ["learning evidence"],
		profile: "strict",
		host: "codex",
		context: { taskType: "docs" },
		ts: 1_000,
	});
	const evidence = store.recordEvidence({
		runId: run.runId,
		phaseId: "semantic-adversarial-verification",
		evidenceId: "learning-evidence",
		kind: "semantic_review",
		result: "pass",
		rationale: "Learning proposal is backed by review evidence.",
		ts: 1_100,
	});
	return { cwd, store, runId: run.runId, evidenceId: evidence.id };
}
