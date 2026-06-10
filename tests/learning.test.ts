import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	explainLearningPattern,
	exportSharedLearningPattern,
	importSharedLearningPattern,
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

	it("requires redaction, conformance, and reviewer approval for user-scope promotion", () => {
		const { cwd, store, runId, evidenceId } = learningFixture();
		try {
			const userPattern = proposeLearningPattern({
				store,
				runId,
				scope: "user",
				state: "validated",
				pattern: "Reuse audited host handoff checks across local projects.",
				confidence: 0.95,
				evidenceId,
				metadata: { evidenceAudit: "pass" },
			});

			expect(() =>
				promoteLearningPattern({
					store,
					cwd,
					id: userPattern.id,
					approvedBy: "reviewer",
				}),
			).toThrow("user promotion requires redaction pass metadata");

			const completeUserPattern = proposeLearningPattern({
				store,
				runId,
				scope: "user",
				state: "validated",
				pattern: "Carry package smoke checks into local user learning.",
				confidence: 0.96,
				evidenceId,
				metadata: {
					evidenceAudit: "pass",
					redaction: "pass",
					conformance: "pass",
					redactionHash: "redaction-sha",
					conformanceHash: "conformance-sha",
				},
			});
			const userLearningPath = join(cwd, "user-home", ".paveda", "learning", "patterns.json");
			const promoted = promoteLearningPattern({
				store,
				cwd,
				id: completeUserPattern.id,
				scope: "user",
				approvedBy: "reviewer",
				write: true,
				now: 4_000,
				userLearningPath,
			});

			expect(promoted.pattern).toMatchObject({
				state: "promoted",
				scope: "user",
				promotedAt: 4_000,
			});
			expect(promoted.knowledgeFile).toMatchObject({
				path: userLearningPath,
				status: "written",
				patternCount: 1,
			});
			const file = JSON.parse(readFileSync(userLearningPath, "utf8")) as {
				patterns: Array<{
					scope: string;
					approvedBy: string;
					evidenceHash: string;
					redactionHash: string;
					conformanceHash: string;
					reviewDecision: { reviewedBy: string };
				}>;
			};
			expect(file.patterns).toEqual([
				expect.objectContaining({
					scope: "user",
					approvedBy: "reviewer",
					evidenceHash: expect.any(String),
					redactionHash: "redaction-sha",
					conformanceHash: "conformance-sha",
					reviewDecision: expect.objectContaining({ reviewedBy: "reviewer" }),
				}),
			]);
		} finally {
			store.close();
		}
	});

	it("exports and imports reviewed shared learning candidates", () => {
		const { cwd, store, runId, evidenceId } = learningFixture();
		try {
			const shared = proposeLearningPattern({
				store,
				runId,
				scope: "shared",
				state: "validated",
				pattern: "Share release conformance smoke checks through reviewed learning packs.",
				confidence: 0.97,
				evidenceId,
				metadata: {
					evidenceAuditPassed: true,
					redactionPassed: true,
					conformancePassed: true,
				},
			});
			const promoted = promoteLearningPattern({
				store,
				cwd,
				id: shared.id,
				scope: "shared",
				approvedBy: "shared-reviewer",
				write: true,
				now: 5_000,
			});
			const candidatesPath = join(cwd, ".paveda", "learning", "shared-candidates.json");
			expect(promoted.knowledgeFile.path).toBe(candidatesPath);
			expect(existsSync(candidatesPath)).toBe(true);

			const exportPath = join(cwd, "shared-learning.json");
			const exported = exportSharedLearningPattern({
				store,
				id: shared.id,
				out: exportPath,
				now: 5_100,
			});
			expect(exported.pattern).toMatchObject({
				scope: "shared",
				approvedBy: "shared-reviewer",
			});

			const importDir = mkdtempSync(join(tmpdir(), "paveda-learning-import-"));
			tempDirs.push(importDir);
			const imported = importSharedLearningPattern({
				cwd: importDir,
				path: exportPath,
				reviewedBy: "import-reviewer",
				now: 5_200,
			});
			expect(imported).toMatchObject({
				status: "written",
				patternCount: 1,
			});
			expect(imported.imported.reviewDecision).toMatchObject({
				reviewedBy: "import-reviewer",
				reviewedAt: 5_200,
			});
		} finally {
			store.close();
		}
	});

	it("rejects imported shared learning that relaxes gates", () => {
		const { cwd, store, runId, evidenceId } = learningFixture();
		try {
			const shared = proposeLearningPattern({
				store,
				runId,
				scope: "shared",
				state: "validated",
				pattern: "Share package smoke evidence collection across projects.",
				confidence: 0.97,
				evidenceId,
				metadata: {
					evidenceAudit: "pass",
					redaction: "pass",
					conformance: "pass",
				},
			});
			promoteLearningPattern({
				store,
				cwd,
				id: shared.id,
				scope: "shared",
				approvedBy: "shared-reviewer",
				write: true,
			});
			const exportPath = join(cwd, "shared-learning.json");
			exportSharedLearningPattern({ store, id: shared.id, out: exportPath });
			const exported = JSON.parse(readFileSync(exportPath, "utf8")) as {
				pattern: { pattern: string };
			};
			exported.pattern.pattern = "Skip release security gate for shared pack installs.";
			writeFileSync(exportPath, `${JSON.stringify(exported, null, 2)}\n`);

			expect(() =>
				importSharedLearningPattern({
					cwd,
					path: exportPath,
					reviewedBy: "import-reviewer",
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
