import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConformanceResult } from "../src/conformance/index.js";
import type { VerifyRunResult } from "../src/execution/index.js";
import {
	conformanceReport,
	renderJUnit,
	verificationReport,
	writeReports,
} from "../src/reporters/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("reporters", () => {
	it("renders blocked verification gates as JUnit failures", () => {
		const report = verificationReport(blockedVerification(), 1_000);
		const junit = renderJUnit(report);

		expect(report).toMatchObject({
			schemaVersion: 1,
			generatedAt: "1970-01-01T00:00:01.000Z",
			ok: false,
		});
		expect(report.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					case: "stage:mechanical",
					status: "block",
					artifactRefs: ["evidence:12"],
				}),
				expect.objectContaining({
					case: "gate:unit-gate",
					status: "block",
					artifactRefs: [],
				}),
				expect.objectContaining({
					case: "ladder:unit_test",
					status: "block",
					artifactRefs: ["evidence:12"],
				}),
			]),
		);
		expect(junit).toContain('<testsuites tests="3" failures="3" skipped="0">');
		expect(junit).toContain('<failure message="unit evidence missing" type="block">');
		expect(junit).toContain('<property name="paveda.artifact" value="evidence:12"/>');
	});

	it("writes normalized JSON and JUnit reports", () => {
		const dir = tempDir("paveda-reports-");
		const result = writeReports(verificationReport(blockedVerification(), 2_000), {
			reportDir: dir,
			prefix: "verify",
		});

		expect(result.jsonPath).toBe(join(dir, "verify.json"));
		expect(result.junitPath).toBe(join(dir, "verify.junit.xml"));
		expect(existsSync(join(dir, "verify.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, "verify.json"), "utf8"))).toMatchObject({
			ok: false,
			nodes: expect.arrayContaining([expect.objectContaining({ case: "gate:unit-gate" })]),
		});
		expect(readFileSync(join(dir, "verify.junit.xml"), "utf8")).toContain(
			'<testsuite name="verify:run-1"',
		);
	});

	it("renders warning gates without counting them as JUnit failures", () => {
		const warning = blockedVerification();
		warning.ok = true;
		warning.gates = [
			{
				id: "spec-binding-gate",
				policyId: "workflow.spec-binding.missing",
				phase: "intake",
				evidenceKind: "spec_binding",
				status: "warn",
				message: "fast code-changing run has no stable spec binding",
				evidenceIds: [],
				recovery: {
					action: "repair_then_block",
					message: "record a spec binding",
				},
			},
		];
		warning.ladder = [
			{
				evidenceKind: "spec_binding",
				status: "warn",
				requiredGateIds: ["spec-binding-gate"],
				evidenceIds: [],
				message: "One or more non-blocking gates emitted warnings.",
			},
		];
		warning.stages = [];
		const report = verificationReport(warning, 2_500);
		const junit = renderJUnit(report);

		expect(report.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ case: "gate:spec-binding-gate", status: "warn" }),
				expect.objectContaining({ case: "ladder:spec_binding", status: "warn" }),
			]),
		);
		expect(junit).toContain('<testsuites tests="2" failures="0" skipped="0">');
	});

	it("renders failed conformance fixtures as JUnit failures", () => {
		const report = conformanceReport(
			{
				ok: false,
				host: "codex",
				profile: "strict",
				cwd: "/tmp/project",
				mode: "isolated-fixture",
				fixtureRoot: null,
				fixtures: [
					{
						id: "fixture-pass",
						status: "pass",
						message: "fixture passed",
					},
					{
						id: "fixture-fail",
						status: "fail",
						message: "fixture failed",
						details: { expected: "pass" },
					},
				],
			} satisfies ConformanceResult,
			3_000,
		);
		const junit = renderJUnit(report);

		expect(report.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ case: "fixture-pass", status: "pass" }),
				expect.objectContaining({ case: "fixture-fail", status: "fail" }),
			]),
		);
		expect(junit).toContain('<testsuites tests="2" failures="1" skipped="0">');
		expect(junit).toContain('<failure message="fixture failed" type="fail">');
	});
});

function blockedVerification(): VerifyRunResult {
	return {
		cwd: "/tmp/project",
		runId: "run-1",
		profile: "strict",
		taskType: "code",
		ok: false,
		gates: [
			{
				id: "unit-gate",
				phase: "unit-test",
				evidenceKind: "unit_test",
				status: "block",
				message: "unit evidence missing",
				evidenceIds: [],
				recovery: {
					action: "record_pass_evidence",
					message: "record unit evidence",
				},
			},
		],
		stages: [
			{
				stage: "mechanical",
				result: "block",
				score: 0,
				confidence: 0,
				required: true,
				triggeredBy: ["verification:deterministic"],
				evidenceIds: [12],
				blockingPolicyViolationIds: [],
				nextCommand: "paveda evidence add --run run-1 --kind unit_test",
			},
		],
		ladder: [
			{
				evidenceKind: "unit_test",
				status: "block",
				requiredGateIds: ["unit-gate"],
				evidenceIds: [12],
				message: "unit ladder blocked",
			},
		],
		scoreSummary: {
			metric: "verification_score",
			value: 0,
			threshold: 1,
			decision: "block",
			requiredGates: 1,
			passedGates: 0,
			notApplicableGates: 0,
			blockedGates: 1,
		},
		score: null,
		policyViolations: [],
	};
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
