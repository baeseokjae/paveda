import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEvidenceFromProviders } from "../src/evidence/providers.js";
import { startPavedaDo, summarizeRun, verifyRun } from "../src/execution/index.js";
import { initializePaveda } from "../src/init/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("evidence providers", () => {
	it("records pass evidence and captured artifacts from a provider command", () => {
		const dir = initProject("paveda-provider-pass-");
		const started = startRun(dir);
		writeEvidencePolicy(dir, [
			{
				id: "unit-provider",
				kind: "unit_test",
				phaseId: "unit-test",
				command: [
					process.execPath,
					"-e",
					"require('node:fs').writeFileSync('unit-report.txt', 'unit ok')",
				],
				artifactGlobs: ["unit-report.txt"],
				passExitCodes: [0],
				failureBehavior: "inconclusive",
			},
		]);

		const result = collectEvidenceFromProviders({
			cwd: dir,
			runId: started.run.runId,
			kind: "unit_test",
			now: 1_500,
		});
		const summary = summarizeRun({ cwd: dir, runId: started.run.runId });

		expect(result.ok).toBe(true);
		expect(result.evidence[0]).toMatchObject({
			evidenceId: "unit-provider",
			kind: "unit_test",
			result: "pass",
			exitCode: 0,
		});
		expect(result.artifacts[0]).toMatchObject({
			kind: "unit_test-artifact",
			redactionStatus: "not_required",
			byteLength: "unit ok".length,
		});
		expect(summary.evidence.map((item) => item.evidenceId)).toContain("unit-provider");
		expect(summary.artifacts).toHaveLength(1);
	});

	it("records configured blocking evidence when a provider command fails", () => {
		const dir = initProject("paveda-provider-fail-");
		const started = startRun(dir);
		writeEvidencePolicy(dir, [
			{
				id: "coverage-provider",
				kind: "coverage",
				phaseId: "unit-test",
				command: [process.execPath, "-e", "process.exit(2)"],
				passExitCodes: [0],
				failureBehavior: "block",
			},
		]);

		const result = collectEvidenceFromProviders({
			cwd: dir,
			runId: started.run.runId,
			providerId: "coverage-provider",
			now: 2_000,
		});

		expect(result.ok).toBe(false);
		expect(result.evidence[0]).toMatchObject({
			evidenceId: "coverage-provider",
			kind: "coverage",
			result: "block",
			exitCode: 2,
		});
	});

	it("marks secret-like artifacts as redaction failures and keeps the gate blocked", () => {
		const dir = initProject("paveda-provider-redaction-");
		const started = startRun(dir);
		writeEvidencePolicy(dir, [
			{
				id: "coverage-secret-provider",
				kind: "coverage",
				phaseId: "unit-test",
				command: [
					process.execPath,
					"-e",
					"require('node:fs').writeFileSync('coverage-secret.txt', 'API_KEY=secret')",
				],
				artifactGlobs: ["coverage-secret.txt"],
				redactionRequired: true,
				passExitCodes: [0],
				failureBehavior: "inconclusive",
			},
		]);

		const result = collectEvidenceFromProviders({
			cwd: dir,
			runId: started.run.runId,
			kind: "coverage",
			now: 3_000,
		});
		const verified = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "strict",
			now: 3_100,
		});

		expect(result.ok).toBe(false);
		expect(result.evidence[0]).toMatchObject({
			evidenceId: "coverage-secret-provider",
			kind: "coverage",
			result: "fail",
		});
		expect(result.artifacts[0]?.redactionStatus).toBe("failed");
		expect(verified.gates.find((gate) => gate.id === "coverage-gate")).toMatchObject({
			status: "block",
			message: "coverage evidence exists but is not passing.",
		});
	});
});

function initProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	expect(existsSync(join(dir, ".paveda", "manifest.json"))).toBe(true);
	return dir;
}

function startRun(dir: string) {
	return startPavedaDo({
		cwd: dir,
		host: "codex",
		profile: "strict",
		objective: "Collect evidence from provider",
		taskType: "code",
		now: 1_000,
	});
}

function writeEvidencePolicy(dir: string, providers: unknown[]): void {
	writeFileSync(
		join(dir, ".paveda", "evidence-policy.json"),
		`${JSON.stringify({ schemaVersion: 1, providers }, null, 2)}\n`,
	);
}
