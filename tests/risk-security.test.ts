import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectEvidenceFromProviders } from "../src/evidence/providers.js";
import { addRunEvidence, startPavedaDo, summarizeRun, verifyRun } from "../src/execution/index.js";
import { initializePaveda } from "../src/init/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("risk and security release ladder", () => {
	it("blocks high-risk release work without risk and security evidence", () => {
		const cwd = initProject("paveda-risk-high-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "release",
			taskType: "code",
			changedFiles: ["src/auth/session.ts"],
			objective: "Change auth session handling",
			now: 1_000,
		});

		const blocked = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "release",
			write: true,
			now: 2_000,
		});
		const summary = summarizeRun({ cwd, runId: started.run.runId });

		expect(blocked.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "risk-gate", status: "block" }),
				expect.objectContaining({ id: "security-gate", status: "block" }),
			]),
		);
		expect(summary.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					decisionType: "risk.surface",
					decision: "auth",
				}),
			]),
		);
		expect(summary.policyViolations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ policyId: "security-gate", blocked: true }),
			]),
		);
	});

	it("does not require release risk or security gates for docs-only work", () => {
		const cwd = initProject("paveda-risk-docs-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "release",
			taskType: "docs",
			changedFiles: ["docs/release.md"],
			objective: "Document release process",
			now: 3_000,
		});

		const verified = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "release",
			now: 4_000,
		});

		expect(verified.gates.map((gate) => gate.id)).not.toContain("risk-gate");
		expect(verified.gates.map((gate) => gate.id)).not.toContain("security-gate");
		expect(verified.ladder).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ evidenceKind: "risk_review", status: "not_required" }),
				expect.objectContaining({ evidenceKind: "security_scan", status: "not_required" }),
			]),
		);
	});

	it("accepts project-declared security scan provider evidence for high-risk release work", () => {
		const cwd = initProject("paveda-risk-provider-");
		const started = startPavedaDo({
			cwd,
			host: "codex",
			profile: "release",
			taskType: "api",
			riskSurfaces: ["public-api"],
			objective: "Change public API",
			now: 5_000,
		});
		writeSecurityProvider(cwd);

		const collected = collectEvidenceFromProviders({
			cwd,
			runId: started.run.runId,
			kind: "security_scan",
			now: 5_500,
		});
		addRunEvidence({
			cwd,
			runId: started.run.runId,
			phaseId: "semantic-adversarial-verification",
			evidenceId: "risk-review-pass",
			kind: "risk_review",
			result: "pass",
			rationale: "Manual public API risk review passed.",
			metadata: {
				reviewedBy: "security-reviewer",
				residualRisk: "low",
				riskSurfaces: ["public-api"],
			},
			now: 5_600,
		});

		const verified = verifyRun({
			cwd,
			runId: started.run.runId,
			profile: "release",
			now: 6_000,
		});

		expect(collected.evidence[0]).toMatchObject({
			kind: "security_scan",
			result: "pass",
		});
		expect(verified.gates.find((gate) => gate.id === "security-gate")).toMatchObject({
			status: "pass",
		});
		expect(verified.gates.find((gate) => gate.id === "risk-gate")).toMatchObject({
			status: "pass",
		});
	});
});

function initProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	return dir;
}

function writeSecurityProvider(cwd: string): void {
	writeFileSync(
		join(cwd, ".paveda", "evidence-policy.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				providers: [
					{
						id: "security-provider",
						kind: "security_scan",
						phaseId: "semantic-adversarial-verification",
						command: [process.execPath, "-e", "process.exit(0)"],
						passExitCodes: [0],
						failureBehavior: "block",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
}
