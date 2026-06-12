import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { verifyRun } from "../src/execution/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { EventStore } from "../src/store/index.js";
import { listWorkers, runWorker, scheduleWorker, workerLogs } from "../src/worker/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ADR 0002 phase 3", () => {
	it("supports review verification stage and records review events", () => {
		const store = openTempStore();
		const run = store.createRun({
			objective: "ship reviewed change",
			profile: "fast",
			context: { taskType: "code" },
		});
		store.recordEvidence({
			runId: run.runId,
			phaseId: "review",
			evidenceId: "spec-compliance",
			kind: "spec_compliance_review",
			result: "pass",
			rationale: "matches spec",
		});
		store.recordEvidence({
			runId: run.runId,
			phaseId: "review",
			evidenceId: "code-quality",
			kind: "code_quality_review",
			result: "pass",
			rationale: "quality checks passed",
		});
		store.close();

		const result = verifyRun({
			cwd: process.cwd(),
			dbPath: tempDbPath(store),
			runId: run.runId,
			profile: "fast",
			stage: "review",
			write: true,
		});
		expect(result.stages).toHaveLength(1);
		expect(result.stages[0]).toMatchObject({ stage: "review", result: "pass" });

		const reopened = new EventStore(tempDbPath(store));
		expect(reopened.replay(run.runId).map((event) => event.type)).toEqual(
			expect.arrayContaining(["review.stage", "review.severity"]),
		);
		reopened.close();
	});

	it("adds verification_passed to session completion events", () => {
		const store = openTempStore();
		const run = store.createRun({ objective: "complete after verify", profile: "fast" });
		store.recordScore({
			runId: run.runId,
			metric: "verification_score",
			value: 1,
			decision: "pass",
		});
		const result = dispatchHookEvent(store, {
			sessionId: "session-complete",
			lifecycle: "session.completed",
			matcher: "session",
			payload: { runId: run.runId },
			config: config({ hookProfile: "strict" }),
		});
		expect(result.completionGate).toMatchObject({ verificationPassed: true, blocked: false });
		expect(store.replay("session-complete")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "session.completed",
					payload: expect.objectContaining({ verification_passed: true }),
				}),
				expect.objectContaining({ type: "session.completion_gate" }),
			]),
		);
		store.close();
	});

	it("installs optional unstuck skill from builtin manifest", async () => {
		const { installBuiltinSkill } = await import("../src/skill-loader/index.js");
		const cwd = makeTempDir();
		const result = installBuiltinSkill({ cwd, name: "unstuck", write: true });
		expect(result).toMatchObject({ name: "unstuck", written: true });
		expect(result.targetPath).toContain(join(".harness", "skills", "unstuck", "SKILL.md"));
	});

	it("schedules, runs, and logs workers", () => {
		const cwd = makeTempDir();
		const scheduled = scheduleWorker({
			cwd,
			name: "security-nightly",
			task: "security-scan",
			schedule: "0 2 * * *",
			write: true,
		});
		expect(scheduled.written).toBe(true);
		expect(listWorkers({ cwd })).toMatchObject([
			{ name: "security-nightly", task: "security-scan" },
		]);
		const run = runWorker({ cwd, name: "security-nightly", dbPath: join(cwd, "store.db") });
		expect(run).toMatchObject({ name: "security-nightly", task: "security-scan", ok: true });
		expect(
			workerLogs({ cwd, dbPath: join(cwd, "store.db"), name: "security-nightly" }),
		).toHaveLength(1);
	});
});

function openTempStore(): EventStore {
	const dir = makeTempDir();
	const dbPath = join(dir, "store.db");
	const store = new EventStore(dbPath) as EventStore & { __dbPath?: string };
	store.__dbPath = dbPath;
	return store;
}

function tempDbPath(store: EventStore): string {
	return (store as EventStore & { __dbPath: string }).__dbPath;
}

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "paveda-phase3-"));
	tempDirs.push(dir);
	return dir;
}

function config(overrides: Partial<PavedaConfig> = {}): PavedaConfig {
	return {
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: false,
		sessionStartMaxChars: 8000,
		costGuardMaxMinutes: 120,
		costGuardMaxUsd: 5,
		costGuardMaxTokens: 1_000_000,
		costGuardAgentWarningThreshold: 5,
		costGuardAgentCompactInterval: 3,
		...overrides,
	};
}
