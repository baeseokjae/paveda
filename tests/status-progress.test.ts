import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPavedaDo } from "../src/execution/index.js";
import { initializePaveda } from "../src/init/index.js";
import {
	formatHandoffMarkdown,
	formatProgressMarkdown,
	summarizeProgress,
	summarizeRunWithProgress,
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
			"status",
			"taskType",
		]);
		expect(progress.nextCommands[0]).toContain("paveda evidence add");
	});
});

function initProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	return dir;
}
