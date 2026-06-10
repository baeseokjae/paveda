import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateContractSource } from "../src/contract/index.js";
import {
	addRunEvidence,
	runHostCommand,
	startPavedaDo,
	summarizeRun,
	verifyRun,
} from "../src/execution/index.js";
import { initializePaveda } from "../src/init/index.js";
import { EventStore, resolveStorePath } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("contract-first CLI flow", () => {
	it("validates .paveda contract source files and rejects profile drift", () => {
		const dir = initCodexProject("paveda-contract-validate-");

		const valid = validateContractSource({ cwd: dir, host: "codex", profile: "strict" });
		expect(valid.ok).toBe(true);
		expect(valid.checks.map((check) => check.status)).not.toContain("fail");

		const profilePath = join(dir, ".paveda", "profiles", "strict.json");
		const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
		profile.silentTypo = true;
		writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

		const invalid = validateContractSource({ cwd: dir, host: "codex", profile: "strict" });
		expect(invalid.ok).toBe(false);
		expect(invalid.checks.find((check) => check.name === "profile")).toMatchObject({
			status: "fail",
		});
	});

	it("blocks strict code-changing runs until unit and e2e evidence pass", () => {
		const dir = initCodexProject("paveda-contract-do-");

		const started = startPavedaDo({
			cwd: dir,
			host: "codex",
			profile: "strict",
			objective: "Change executable behavior",
			taskType: "code",
			acceptanceCriteria: ["unit evidence", "e2e evidence"],
			now: 1_000,
		});
		expect(started.run.profile).toBe("strict");
		expect(started.run.context).toMatchObject({
			taskType: "code",
			entrypoint: "paveda do",
			hostNativePrimitive: "goal",
		});
		expect(started.hostNative).toMatchObject({
			status: "native_handoff",
			primitive: "goal",
			eventType: "codex.goal.created",
			normalizedStatus: "active",
		});
		const startedSummary = summarizeRun({ cwd: dir, runId: started.run.runId });
		expect(startedSummary.hostEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					host: "codex",
					eventType: "codex.goal.created",
					normalizedStatus: "active",
				}),
			]),
		);
		expect(startedSummary.phaseEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					phaseId: "intake",
					eventType: "codex.goal.created",
					status: "active",
				}),
			]),
		);

		const blocked = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "strict",
			now: 2_000,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "unit-gate", status: "block" }),
				expect.objectContaining({ id: "e2e-gate", status: "block" }),
			]),
		);

		addRunEvidence({
			cwd: dir,
			runId: started.run.runId,
			phaseId: "unit-test",
			evidenceId: "unit-pass",
			kind: "unit_test",
			result: "pass",
			command: "pnpm test",
			exitCode: 0,
			rationale: "focused unit test passed",
			now: 3_000,
		});
		addRunEvidence({
			cwd: dir,
			runId: started.run.runId,
			phaseId: "e2e-test",
			evidenceId: "e2e-pass",
			kind: "e2e_test",
			result: "pass",
			command: "pnpm package:check",
			exitCode: 0,
			rationale: "package-level e2e smoke passed",
			now: 4_000,
		});
		for (const [index, evidence] of [
			["coverage", "coverage", "pnpm test -- --coverage"],
			["typecheck", "typecheck", "pnpm typecheck"],
			["lint", "lint", "pnpm lint"],
			["build", "build", "pnpm build"],
			["semantic", "semantic_review", "semantic review"],
			["risk", "risk_review", "risk review"],
		] as const) {
			addRunEvidence({
				cwd: dir,
				runId: started.run.runId,
				phaseId: "semantic-adversarial-verification",
				evidenceId: `${index}-pass`,
				kind: evidence,
				result: "pass",
				command: index === "semantic" || index === "risk" ? undefined : evidence,
				exitCode: index === "semantic" || index === "risk" ? undefined : 0,
				rationale: `${evidence} passed`,
				now: 4_100,
			});
		}

		const passed = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "strict",
			write: true,
			now: 5_000,
		});
		expect(passed.ok).toBe(true);
		expect(passed.score).toMatchObject({ metric: "verification_score", value: 1 });
		expect(passed.scoreSummary).toMatchObject({
			decision: "pass",
			blockedGates: 0,
		});
		expect(passed.ladder.find((step) => step.evidenceKind === "e2e_test")).toMatchObject({
			status: "pass",
		});
	});

	it("does not accept unit or e2e not_applicable evidence for code-changing tasks", () => {
		const dir = initCodexProject("paveda-contract-code-na-");
		const started = startPavedaDo({
			cwd: dir,
			host: "codex",
			profile: "strict",
			objective: "Change executable behavior",
			taskType: "code",
			now: 6_000,
		});

		for (const [id, phase, kind] of [
			["unit-na", "unit-test", "unit_test"],
			["e2e-na", "e2e-test", "e2e_test"],
		] as const) {
			addRunEvidence({
				cwd: dir,
				runId: started.run.runId,
				phaseId: phase,
				evidenceId: id,
				kind,
				result: "not_applicable",
				rationale: "No test target selected",
				metadata: { classifierReason: "misclassified code change", userApproval: true },
				now: 6_100,
			});
		}

		const blocked = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "strict",
			now: 6_200,
		});
		expect(blocked.ok).toBe(false);
		expect(blocked.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "unit-gate", status: "block" }),
				expect.objectContaining({ id: "e2e-gate", status: "block" }),
			]),
		);
		expect(blocked.gates.find((gate) => gate.id === "unit-gate")?.message).toContain(
			"not_applicable is only allowed",
		);
	});

	it("allows docs-only tasks through audited not_applicable unit and e2e evidence", () => {
		const dir = initCodexProject("paveda-contract-docs-na-");
		const started = startPavedaDo({
			cwd: dir,
			host: "codex",
			profile: "strict",
			objective: "Document the contract flow",
			taskType: "docs",
			now: 7_000,
		});

		for (const [id, phase, kind] of [
			["unit-na", "unit-test", "unit_test"],
			["e2e-na", "e2e-test", "e2e_test"],
		] as const) {
			addRunEvidence({
				cwd: dir,
				runId: started.run.runId,
				phaseId: phase,
				evidenceId: id,
				kind,
				result: "not_applicable",
				rationale: "Docs-only change does not alter executable behavior.",
				metadata: { classifierReason: "changed files are documentation only", userApproval: true },
				now: 7_100,
			});
		}
		for (const [id, kind] of [
			["semantic-pass", "semantic_review"],
			["risk-pass", "risk_review"],
		] as const) {
			addRunEvidence({
				cwd: dir,
				runId: started.run.runId,
				phaseId: "semantic-adversarial-verification",
				evidenceId: id,
				kind,
				result: "pass",
				rationale: `${kind} passed for docs-only change`,
				now: 7_200,
			});
		}

		const passed = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "strict",
			write: true,
			now: 7_300,
		});
		expect(passed.ok).toBe(true);
		expect(passed.scoreSummary).toMatchObject({
			requiredGates: 4,
			notApplicableGates: 2,
			blockedGates: 0,
			decision: "pass",
		});
		expect(
			passed.gates.filter((gate) => gate.status === "not_applicable").map((gate) => gate.id),
		).toEqual(["unit-gate", "e2e-gate"]);
	});

	it("wraps a host-native command and records command evidence plus artifacts", () => {
		const dir = initCodexProject("paveda-contract-run-");

		const result = runHostCommand({
			cwd: dir,
			host: "codex",
			profile: "strict",
			nativeArgs: [process.execPath, "-e", "process.stdout.write('wrapped-ok')"],
			objective: "Run a packaged native command",
			taskType: "command",
			now: 10_000,
		});

		expect(result.exitCode).toBe(0);
		expect(result.run.status).toBe("completed");
		expect(result.evidence).toMatchObject({
			evidenceId: "native-command",
			kind: "command",
			result: "pass",
			exitCode: 0,
		});
		expect(result.stdoutArtifact).toMatchObject({
			kind: "command-stdout",
			byteLength: "wrapped-ok".length,
		});

		const summary = summarizeRun({ cwd: dir, runId: result.run.runId });
		expect(summary.evidence.map((item) => item.evidenceId)).toContain("native-command");
		expect(summary.artifacts).toHaveLength(1);
	});

	it("blocks run start when generated projections drift", () => {
		const dir = initCodexProject("paveda-contract-drift-");
		writeFileSync(join(dir, "AGENTS.md"), "local drift\n");

		expect(() =>
			startPavedaDo({
				cwd: dir,
				host: "codex",
				objective: "Attempt with drifted projection",
				taskType: "code",
			}),
		).toThrow("Projection drift blocks run");
	});

	it("executes release profile runs and blocks until release gates pass", () => {
		const dir = initCodexProject("paveda-contract-release-");

		const command = runHostCommand({
			cwd: dir,
			host: "codex",
			profile: "release",
			nativeArgs: [process.execPath, "-e", "process.stdout.write('release-ok')"],
			now: 11_000,
		});
		expect(command.exitCode).toBe(0);
		expect(command.stdoutArtifact?.metadata).toMatchObject({
			releaseRetention: {
				policy: "release",
				mode: "immutable",
				immutable: true,
			},
		});

		const started = startPavedaDo({
			cwd: dir,
			host: "codex",
			profile: "release",
			objective: "Release executable behavior",
			taskType: "code",
			now: 12_000,
		});
		const missing = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "release",
			now: 12_100,
		});
		expect(missing.ok).toBe(false);
		expect(missing.gates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "release-signoff", status: "block" }),
				expect.objectContaining({ id: "full-conformance", status: "block" }),
				expect.objectContaining({ id: "immutable-artifact-retention", status: "block" }),
			]),
		);

		const artifact = writeReleaseArtifact(dir, started.run.runId, 12_200);
		recordCompleteReleaseEvidence(dir, started.run.runId, artifact.id, 12_300);
		const passed = verifyRun({
			cwd: dir,
			runId: started.run.runId,
			profile: "release",
			write: true,
			now: 12_500,
		});
		expect(passed.ok).toBe(true);
		expect(passed.scoreSummary).toMatchObject({
			requiredGates: 9,
			blockedGates: 0,
			decision: "pass",
		});
	});
});

function initCodexProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	expect(existsSync(join(dir, ".paveda", "manifest.json"))).toBe(true);
	return dir;
}

function writeReleaseArtifact(cwd: string, runId: string, now: number) {
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		return store.writeArtifact({
			runId,
			kind: "release-trace",
			fileName: "release-retention.txt",
			content: "release artifact\n",
			metadata: {
				releaseRetention: {
					policy: "release",
					mode: "immutable",
					immutable: true,
					redactionStatus: "not_required",
					capturedAt: now,
				},
			},
			createdAt: now,
		});
	} finally {
		store.close();
	}
}

function recordCompleteReleaseEvidence(
	cwd: string,
	runId: string,
	artifactId: number,
	now: number,
): void {
	const evidence = [
		["unit-pass", "unit-test", "unit_test", "pnpm test", 0, null],
		["e2e-pass", "e2e-test", "e2e_test", "pnpm package:check", 0, null],
		["coverage-pass", "unit-test", "coverage", "pnpm test -- --coverage", 0, null],
		["semantic-pass", "semantic-adversarial-verification", "semantic_review", null, null, null],
		[
			"risk-pass",
			"semantic-adversarial-verification",
			"risk_review",
			null,
			null,
			{ reviewedBy: "release-manager", residualRisk: "low", riskSurfaces: ["mixed"] },
		],
		[
			"adversarial-pass",
			"semantic-adversarial-verification",
			"adversarial_review",
			null,
			null,
			null,
		],
		[
			"security-pass",
			"semantic-adversarial-verification",
			"security_scan",
			"pnpm audit",
			0,
			{ scanner: "pnpm audit" },
		],
		[
			"release-signoff-pass",
			"handoff",
			"manual_decision",
			null,
			null,
			{ releaseSignoff: true, approvedBy: "release-manager" },
		],
		[
			"full-conformance-pass",
			"handoff",
			"host_event",
			null,
			null,
			{ conformanceOk: true, fixturesPassed: ["release-missing-gates-blocks"] },
		],
		[
			"immutable-retention-pass",
			"handoff",
			"trace",
			null,
			null,
			{ artifactRetention: "immutable" },
		],
	] as const;
	for (const [
		index,
		[evidenceId, phaseId, kind, command, exitCode, metadata],
	] of evidence.entries()) {
		addRunEvidence({
			cwd,
			runId,
			phaseId,
			evidenceId,
			kind,
			result: "pass",
			command,
			exitCode,
			artifactId: evidenceId === "immutable-retention-pass" ? artifactId : null,
			rationale: `${kind} passed for release flow test.`,
			metadata,
			now: now + index,
		});
	}
}
