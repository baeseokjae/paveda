import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addRunEvidence, startPavedaDo, verifyRun } from "../src/execution/index.js";
import { initializePaveda } from "../src/init/index.js";
import {
	diffProgress,
	formatHandoffMarkdown,
	formatProgressMarkdown,
	formatRunReportHtml,
	formatRunReportMarkdown,
	monitorProgress,
	summarizeProgress,
	summarizeRunWithProgress,
	watchProgress,
} from "../src/progress/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("run progress surface", () => {
	it("summarizes blocked gates, latest host event, and next evidence commands", () => {
		const cwd = initProject("paveda-progress-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Implement progress summary",
			now: 1_000,
		});

		const status = summarizeRunWithProgress({ cwd, runId: started.run.runId });
		const progress = status.progress;
		const markdown = formatProgressMarkdown(progress);
		const handoff = formatHandoffMarkdown(progress);

		expect(progress).toMatchObject({
			schemaVersion: 1,
			runId: started.run.runId,
			status: "active",
			host: "codex",
			profile: "strict",
			taskType: "code",
			currentPhase: expect.objectContaining({
				phaseId: "intake",
				status: "active",
			}),
			latestHostEvent: expect.objectContaining({
				host: "codex",
				eventType: "codex.goal.created",
			}),
		});
		expect(progress.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "unit-gate", status: "block" }),
				expect.objectContaining({ id: "e2e-gate", status: "block" }),
			]),
		);
		expect(progress.evidenceGaps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					gateId: "unit-gate",
					nextCommand: expect.stringContaining("paveda evidence add"),
				}),
			]),
		);
		expect(markdown).toContain("## Evidence Gaps");
		expect(markdown).toContain("unit-gate");
		expect(handoff).toContain("## Next Commands");
	});

	it("returns a stable progress schema directly", () => {
		const cwd = initProject("paveda-progress-schema-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "fast",
			taskType: "docs",
			objective: "Document progress summary",
			now: 2_000,
		});

		const progress = summarizeProgress({ cwd, runId: started.run.runId });

		expect(Object.keys(progress).sort()).toEqual([
			"currentPhase",
			"evidenceGaps",
			"gates",
			"host",
			"latestHostEvent",
			"nextCommands",
			"profile",
			"runId",
			"schemaVersion",
			"specBinding",
			"stages",
			"stagnation",
			"status",
			"taskType",
		]);
		expect(progress.nextCommands[0]).toContain("paveda evidence add");
	});

	it("records spec binding details and renders them in progress and handoff output", () => {
		const cwd = initProject("paveda-spec-binding-");
		writeFileSync(join(cwd, "SPEC.md"), "# Spec\n\nBuild the binding surface.\n");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Implement spec binding",
			acceptanceCriteria: ["records hash", "shows handoff summary"],
			fromSpec: "SPEC.md",
			ambiguityScore: 0.1,
			now: 3_000,
		});

		const progress = summarizeProgress({ cwd, runId: started.run.runId });
		const handoff = formatHandoffMarkdown(progress);

		expect(progress.specBinding).toMatchObject({
			sourceType: "spec_file",
			sourcePath: "SPEC.md",
			ambiguityScore: 0.1,
			contractVersion: "profile:strict",
		});
		expect(progress.specBinding?.bindingId).toHaveLength(64);
		expect(progress.specBinding?.specSha256).toHaveLength(64);
		expect(progress.specBinding?.acceptanceSha256).toHaveLength(64);
		expect(handoff).toContain("Spec binding:");
		expect(handoff).toContain(progress.specBinding?.bindingId);
	});

	it("blocks verification when the source spec drifts after run binding", () => {
		const cwd = initProject("paveda-spec-drift-");
		writeFileSync(join(cwd, "SPEC.md"), "# Spec\n\nInitial contract.\n");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Implement from stable spec",
			fromSpec: "SPEC.md",
			acceptanceCriteria: ["stable contract"],
			now: 4_000,
		});
		writeFileSync(join(cwd, "SPEC.md"), "# Spec\n\nChanged contract.\n");

		const result = verifyRun({ cwd, runId: started.run.runId, profile: "strict" });

		expect(result.ok).toBe(false);
		expect(result.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "spec-binding-gate",
					policyId: "workflow.spec-binding.drift",
					status: "block",
					message: expect.stringContaining("source spec hash differs"),
				}),
			]),
		);
	});

	it("warns but does not block fast code-changing runs without spec binding", () => {
		const cwd = initProject("paveda-spec-fast-warning-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "fast",
			taskType: "code",
			objective: "Implement without binding in fast mode",
			now: 4_100,
		});
		addRunEvidence({
			cwd,
			runId: started.run.runId,
			phaseId: "unit-test",
			evidenceId: "unit-pass",
			kind: "unit_test",
			result: "pass",
			rationale: "Unit evidence passed.",
			now: 4_150,
		});

		const verified = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "fast",
			write: true,
			now: 4_200,
		});
		const progress = summarizeProgress({ cwd, runId: started.run.runId });
		const markdown = formatProgressMarkdown(progress);

		expect(verified.ok).toBe(true);
		expect(verified.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					policyId: "workflow.spec-binding.missing",
					status: "warn",
				}),
			]),
		);
		expect(verified.policyViolations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					policyId: "workflow.spec-binding.missing",
					severity: "warning",
					blocked: false,
				}),
			]),
		);
		expect(progress.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "spec-binding-gate",
					status: "warn",
				}),
			]),
		);
		expect(markdown).toContain("spec-binding-gate: warn");
	});

	it("blocks strict code-changing runs without spec binding with a specific policy id", () => {
		const cwd = initProject("paveda-spec-strict-missing-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Implement without binding in strict mode",
			now: 4_300,
		});

		const verified = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "strict",
			write: true,
			now: 4_400,
		});

		expect(verified.ok).toBe(false);
		expect(verified.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					policyId: "workflow.spec-binding.missing",
					status: "block",
				}),
			]),
		);
		expect(verified.policyViolations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					policyId: "workflow.spec-binding.missing",
					blocked: true,
				}),
			]),
		);
	});

	it("surfaces stagnation recovery in progress and handoff output", () => {
		const cwd = initProject("paveda-stagnation-progress-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Recover from a stuck loop",
			now: 5_000,
		});
		for (const iteration of [1, 2, 3]) {
			addIterationEvidence(cwd, started.run.runId, iteration, {
				outputHash: "a".repeat(64),
				verificationScore: 0.2,
				failureFingerprint: "unit-gate:missing",
			});
		}

		const progress = summarizeProgress({ cwd, runId: started.run.runId });
		const markdown = formatProgressMarkdown(progress);
		const handoff = formatHandoffMarkdown(progress);

		expect(progress.stagnation).toMatchObject({
			pattern: "spinning",
			severity: "block",
			iterations: [1, 2, 3],
		});
		expect(progress.nextCommands[0]).toContain("stagnation-recovery");
		expect(markdown).toContain("## Recovery");
		expect(handoff).toContain("Stagnation: spinning");
		const status = summarizeRunWithProgress({ cwd, runId: started.run.runId });
		const reportMarkdown = formatRunReportMarkdown(status);
		const html = formatRunReportHtml(progress, 5_100, status);
		expect(reportMarkdown).toContain("## Run Summary");
		expect(reportMarkdown).toContain("## Verification Stages");
		expect(reportMarkdown).toContain("## Evidence Table");
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("Paveda Run");
		expect(html).toContain("Phase Timeline");
		expect(html).toContain("Evidence Table");
		expect(html).toContain("spinning");
		expect(html).toContain("stagnation-recovery");
	});

	it("blocks strict verification when stagnation repeats", () => {
		const cwd = initProject("paveda-stagnation-verify-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Detect stuck verification loop",
			now: 6_000,
		});
		for (const [iteration, diffHash] of [
			[1, "a".repeat(64)],
			[2, "b".repeat(64)],
			[3, "a".repeat(64)],
			[4, "b".repeat(64)],
		] as const) {
			addIterationEvidence(cwd, started.run.runId, iteration, {
				diffHash,
				verificationScore: 0.3,
				failureFingerprint: `failure-${iteration % 2}`,
			});
		}

		const verified = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "strict",
			write: true,
			now: 7_000,
		});

		expect(verified.ok).toBe(false);
		expect(verified.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "stagnation-gate",
					status: "block",
					message: expect.stringContaining("oscillation detected"),
				}),
			]),
		);
		expect(verified.policyViolations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					policyId: "workflow.stagnation.recovery-required",
					severity: "block",
					blocked: true,
				}),
			]),
		);
	});

	it("detects no_drift and diminishing_returns stagnation patterns", () => {
		const noDriftCwd = initProject("paveda-no-drift-");
		const noDrift = startPavedaDo({
			cwd: noDriftCwd,
			host: "codex",
			profile: "standard",
			taskType: "code",
			objective: "Detect no drift",
			now: 8_000,
		});
		for (const iteration of [1, 2, 3]) {
			addIterationEvidence(noDriftCwd, noDrift.run.runId, iteration, {
				failureFingerprint: "same-failure",
				verificationScore: 0.4,
			});
		}

		const diminishingCwd = initProject("paveda-diminishing-");
		const diminishing = startPavedaDo({
			cwd: diminishingCwd,
			host: "codex",
			profile: "standard",
			taskType: "code",
			objective: "Detect diminishing returns",
			now: 9_000,
		});
		for (const [iteration, verificationScore] of [
			[1, 0.2],
			[2, 0.35],
			[3, 0.355],
			[4, 0.358],
		] as const) {
			addIterationEvidence(diminishingCwd, diminishing.run.runId, iteration, {
				failureFingerprint: `failure-${iteration}`,
				verificationScore,
			});
		}

		expect(
			summarizeProgress({ cwd: noDriftCwd, runId: noDrift.run.runId }).stagnation,
		).toMatchObject({
			pattern: "no_drift",
			severity: "warning",
		});
		expect(
			summarizeProgress({ cwd: diminishingCwd, runId: diminishing.run.runId }).stagnation,
		).toMatchObject({
			pattern: "diminishing_returns",
			severity: "warning",
		});
	});
});

function initProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	return dir;
}

function addIterationEvidence(
	cwd: string,
	runId: string,
	iteration: number,
	fingerprint: {
		outputHash?: string;
		diffHash?: string;
		failureFingerprint?: string;
		verificationScore?: number;
	},
): void {
	addRunEvidence({
		cwd,
		runId,
		phaseId: "execute",
		evidenceId: `iteration-${iteration}`,
		kind: "iteration_fingerprint",
		result: "inconclusive",
		metadata: {
			iterationFingerprint: {
				iteration,
				...fingerprint,
			},
		},
		now: 5_000 + iteration,
	});
}

describe("watch progress", () => {
	it("emits a single event with --once flag", async () => {
		const cwd = initProject("paveda-watch-once-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Test watch once",
			now: 1_000,
		});

		const events: unknown[] = [];
		for await (const event of watchProgress({
			cwd,
			runId: started.run.runId,
			once: true,
		})) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "snapshot",
			pollCount: 1,
			runCompleted: false,
			progress: expect.objectContaining({
				runId: started.run.runId,
				status: "active",
			}),
		});
	});

	it("emits snapshot for active runs", async () => {
		const cwd = initProject("paveda-watch-active-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Test watch active",
			now: 1_000,
		});

		const events: unknown[] = [];
		for await (const event of watchProgress({
			cwd,
			runId: started.run.runId,
			once: true,
		})) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "snapshot",
			runCompleted: false,
		});
	});

	it("respects custom interval", async () => {
		const cwd = initProject("paveda-watch-interval-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Test watch interval",
			now: 1_000,
		});

		const start = Date.now();
		const events: unknown[] = [];
		for await (const event of watchProgress({
			cwd,
			runId: started.run.runId,
			intervalMs: 500,
			once: true,
		})) {
			events.push(event);
		}
		const elapsed = Date.now() - start;

		// Should complete quickly (< 1s, no actual sleep for once mode)
		expect(elapsed).toBeLessThan(1000);
		expect(events).toHaveLength(1);
	});
});

describe("diff progress", () => {
	it("detects status change", () => {
		const active: ReturnType<typeof summarizeProgress> = {
			schemaVersion: 1,
			runId: "0193a7e2-8f5d-7a6b-9c4e-0d1f2a3b4c5d",
			status: "active",
			host: null,
			profile: "standard",
			taskType: "code",
			specBinding: null,
			stagnation: null,
			currentPhase: null,
			latestHostEvent: null,
			stages: [],
			gates: [],
			evidenceGaps: [],
			nextCommands: [],
		};
		const blocked = { ...active, status: "blocked" as const };

		const changes = diffProgress(active, blocked);
		expect(changes).toEqual([expect.objectContaining({ type: "status_changed" })]);
	});

	it("detects phase change", () => {
		const base: ReturnType<typeof summarizeProgress> = {
			schemaVersion: 1,
			runId: "0193a7e2-8f5d-7a6b-9c4e-0d1f2a3b4c5d",
			status: "active",
			host: null,
			profile: "standard",
			taskType: "code",
			specBinding: null,
			stagnation: null,
			currentPhase: null,
			latestHostEvent: null,
			stages: [],
			gates: [],
			evidenceGaps: [],
			nextCommands: [],
		};
		const withPhase = {
			...base,
			currentPhase: {
				phaseId: "execute",
				status: "active",
				eventType: "phase.started",
				ts: 2_000,
			},
		};

		const changes = diffProgress(base, withPhase);
		expect(changes).toContainEqual(expect.objectContaining({ type: "phase_changed" }));
	});

	it("detects gate status change", () => {
		const base: ReturnType<typeof summarizeProgress> = {
			schemaVersion: 1,
			runId: "run-1",
			status: "active",
			host: null,
			profile: "standard",
			taskType: "code",
			specBinding: null,
			stagnation: null,
			currentPhase: null,
			latestHostEvent: null,
			stages: [],
			gates: [
				{ id: "unit-gate", phase: "", evidenceKind: "unit_test", status: "block", message: "" },
			],
			evidenceGaps: [],
			nextCommands: [],
		};
		const changed = {
			...base,
			gates: [
				{ id: "unit-gate", phase: "", evidenceKind: "unit_test", status: "pass", message: "" },
			],
		};

		const changes = diffProgress(base, changed);
		expect(changes).toContainEqual(expect.objectContaining({ type: "gate_changed" }));
	});

	it("detects stagnation change", () => {
		const base: ReturnType<typeof summarizeProgress> = {
			schemaVersion: 1,
			runId: "run-1",
			status: "active",
			host: null,
			profile: "standard",
			taskType: "code",
			specBinding: null,
			stagnation: null,
			currentPhase: null,
			latestHostEvent: null,
			stages: [],
			gates: [],
			evidenceGaps: [],
			nextCommands: [],
		};
		const changed = {
			...base,
			stagnation: {
				pattern: "spinning",
				phaseId: "execute",
				iterations: [1, 2, 3],
				severity: "warning",
				message: "stagnation detected",
				recovery: "review",
				nextCommand: "paveda evidence add",
			},
		};

		const changes = diffProgress(base, changed);
		expect(changes).toContainEqual(expect.objectContaining({ type: "stagnation_changed" }));
	});

	it("returns no changes for identical snapshots", () => {
		const base: ReturnType<typeof summarizeProgress> = {
			schemaVersion: 1,
			runId: "0193a7e2-8f5d-7a6b-9c4e-0d1f2a3b4c5d",
			status: "active",
			host: null,
			profile: "standard",
			taskType: "code",
			specBinding: null,
			stagnation: null,
			currentPhase: { phaseId: "intake", status: "active", eventType: "phase.started", ts: 1000 },
			latestHostEvent: null,
			stages: [],
			gates: [
				{
					id: "unit-gate",
					phase: "unit-test",
					evidenceKind: "unit_test",
					status: "block",
					message: "missing",
				},
			],
			evidenceGaps: [
				{
					gateId: "unit-gate",
					phase: "unit-test",
					evidenceKind: "unit_test",
					message: "missing",
					nextCommand: "paveda evidence add",
				},
			],
			nextCommands: ["paveda evidence add"],
		};
		const currentPhase = base.currentPhase;
		const changes = diffProgress(base, {
			...base,
			currentPhase: currentPhase ? { ...currentPhase } : null,
		});
		expect(changes).toHaveLength(0);
	});
});

describe("monitor progress", () => {
	it("emits initial snapshot on first poll", async () => {
		const cwd = initProject("paveda-monitor-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Test monitor",
			now: 1_000,
		});

		const events: unknown[] = [];
		for await (const event of monitorProgress({
			cwd,
			runId: started.run.runId,
			once: true,
		})) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "snapshot",
			changes: [expect.objectContaining({ type: "phase_changed" })],
		});
	});

	it("emits events for active run with gate changes", async () => {
		const cwd = initProject("paveda-monitor-active-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "strict",
			taskType: "code",
			objective: "Test monitor active",
			now: 1_000,
		});

		addRunEvidence({
			cwd,
			runId: started.run.runId,
			phaseId: "unit-test",
			evidenceId: "unit-pass",
			kind: "unit_test",
			result: "pass",
			now: 2_000,
		});

		const events: unknown[] = [];
		for await (const event of monitorProgress({
			cwd,
			runId: started.run.runId,
			once: true,
		})) {
			events.push(event);
		}

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "snapshot", runCompleted: false });
	});
});
