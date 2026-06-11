import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fromClaudeCodeHookPayload } from "../adapters/claude-code/index.js";
import { normalizeCodexGoalLifecycleEvent } from "../adapters/codex/index.js";
import { fromHermesHookPayload } from "../adapters/hermes/index.js";
import { fromPiHookPayload } from "../adapters/pi/index.js";
import { loadHostCapabilities, parsePavedaProfileValue } from "../contract/index.js";
import { addRunEvidence, startPavedaDo, summarizeRun, verifyRun } from "../execution/index.js";
import { dispatchHookEvent } from "../hook-runtime/index.js";
import { type HostSkillBundleTarget, parseHostSkillBundleTarget } from "../host-bundles/index.js";
import { initializePaveda } from "../init/index.js";
import { EventStore, type PavedaProfile, resolveStorePath } from "../store/index.js";

export interface RunConformanceOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	keepArtifacts?: boolean;
	now?: number;
}

export interface ConformanceResult {
	ok: boolean;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
	cwd: string;
	mode: "isolated-fixture";
	fixtureRoot: string | null;
	fixtures: ConformanceFixtureResult[];
}

export interface ConformanceFixtureResult {
	id: string;
	status: "pass" | "fail";
	message: string;
	details?: unknown;
}

const CODE_FIXTURE = "code-change-without-tests-blocks";
const DOCS_FIXTURE = "docs-only-not-applicable";
const DRIFT_FIXTURE = "projection-drift-blocks";
const RELEASE_MISSING_GATES_FIXTURE = "release-missing-gates-blocks";
const RELEASE_FULL_EVIDENCE_FIXTURE = "release-full-evidence-passes";
const CLAUDE_LIFECYCLE_FIXTURE = "claude-hook-lifecycle-capture";
const CLAUDE_BASH_EVIDENCE_FIXTURE = "claude-bash-command-evidence";
const CODEX_HANDOFF_FIXTURE = "codex-goal-lifecycle-handoff";
const CODEX_STATUS_FIXTURE = "codex-native-goal-status-mapping";
const PI_LIFECYCLE_FIXTURE = "pi-hook-lifecycle-capture";
const PI_COMMAND_EVIDENCE_FIXTURE = "pi-command-evidence";
const HERMES_LIFECYCLE_FIXTURE = "hermes-hook-lifecycle-capture";
const HERMES_COMMAND_EVIDENCE_FIXTURE = "hermes-command-evidence";

export function runConformance(options: RunConformanceOptions): ConformanceResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	if (host === "harness") {
		throw new Error("Conformance host must be claude-code, codex, pi, or hermes");
	}
	const profile = parsePavedaProfileValue(options.profile);
	const fixtureRoot = mkdtempSync(join(tmpdir(), `paveda-conformance-${host}-`));

	try {
		const declaredFixtures = loadHostCapabilities({ cwd, host }).conformanceFixtures;
		const fixtures = declaredFixtures.map((fixtureId, index) =>
			runDeclaredFixture({
				fixtureId,
				host,
				profile,
				root: fixtureRoot,
				now: (options.now ?? Date.now()) + index * 1_000,
			}),
		);

		return {
			ok: fixtures.every((fixture) => fixture.status === "pass"),
			host,
			profile,
			cwd,
			mode: "isolated-fixture",
			fixtureRoot: options.keepArtifacts ? fixtureRoot : null,
			fixtures,
		};
	} finally {
		if (!options.keepArtifacts) {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	}
}

function runDeclaredFixture(input: {
	fixtureId: string;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
	root: string;
	now: number;
}): ConformanceFixtureResult {
	try {
		switch (input.fixtureId) {
			case CODE_FIXTURE:
				return assertCodeChangeWithoutTestsBlocks(input);
			case DOCS_FIXTURE:
				return assertDocsOnlyNotApplicable(input);
			case DRIFT_FIXTURE:
				return assertProjectionDriftBlocks(input);
			case RELEASE_MISSING_GATES_FIXTURE:
				return assertReleaseMissingGatesBlocks(input);
			case RELEASE_FULL_EVIDENCE_FIXTURE:
				return assertReleaseFullEvidencePasses(input);
			case CLAUDE_LIFECYCLE_FIXTURE:
				return assertClaudeLifecycleCapture(input);
			case CLAUDE_BASH_EVIDENCE_FIXTURE:
				return assertClaudeBashCommandEvidence(input);
			case CODEX_HANDOFF_FIXTURE:
				return assertCodexGoalHandoff(input);
			case CODEX_STATUS_FIXTURE:
				return assertCodexStatusMapping(input);
			case PI_LIFECYCLE_FIXTURE:
				return assertPiLifecycleCapture(input);
			case PI_COMMAND_EVIDENCE_FIXTURE:
				return assertPiCommandEvidence(input);
			case HERMES_LIFECYCLE_FIXTURE:
				return assertHermesLifecycleCapture(input);
			case HERMES_COMMAND_EVIDENCE_FIXTURE:
				return assertHermesCommandEvidence(input);
			default:
				return {
					id: input.fixtureId,
					status: "fail",
					message: `No conformance runner exists for fixture: ${input.fixtureId}`,
				};
		}
	} catch (error) {
		return {
			id: input.fixtureId,
			status: "fail",
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

function assertCodeChangeWithoutTestsBlocks(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Conformance code task without tests",
		taskType: "code",
		now: input.now,
	});
	const verified = verifyRun({
		cwd,
		runId: started.run.runId,
		profile: input.profile,
		now: input.now + 1,
	});
	const blockedGateIds = verified.gates
		.filter((gate) => gate.status === "block")
		.map((gate) => gate.id);
	if (!verified.ok && blockedGateIds.includes("unit-gate") && blockedGateIds.includes("e2e-gate")) {
		return pass(CODE_FIXTURE, "strict code-changing task blocks without unit and e2e evidence", {
			runId: started.run.runId,
			blockedGateIds,
		});
	}
	throw new Error("strict code-changing task did not block missing unit/e2e evidence");
}

function assertDocsOnlyNotApplicable(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Conformance docs task",
		taskType: "docs",
		now: input.now,
	});
	for (const [id, phase, kind] of [
		["unit-na", "unit-test", "unit_test"],
		["e2e-na", "e2e-test", "e2e_test"],
	] as const) {
		addRunEvidence({
			cwd,
			runId: started.run.runId,
			phaseId: phase,
			evidenceId: id,
			kind,
			result: "not_applicable",
			rationale: "Docs-only conformance fixture does not alter executable behavior.",
			metadata: {
				classifierReason: "fixture task type is docs",
				userApproval: true,
			},
			now: input.now + 1,
		});
	}
	for (const [id, kind] of [
		["semantic-pass", "semantic_review"],
		["risk-pass", "risk_review"],
	] as const) {
		addRunEvidence({
			cwd,
			runId: started.run.runId,
			phaseId: "semantic-adversarial-verification",
			evidenceId: id,
			kind,
			result: "pass",
			rationale: `${kind} passed for docs-only conformance fixture.`,
			now: input.now + 2,
		});
	}
	const verified = verifyRun({
		cwd,
		runId: started.run.runId,
		profile: input.profile,
		now: input.now + 3,
	});
	if (verified.ok) {
		return pass(DOCS_FIXTURE, "docs-only audited not_applicable evidence satisfies strict gates", {
			runId: started.run.runId,
			scoreSummary: verified.scoreSummary,
		});
	}
	throw new Error("docs-only audited not_applicable evidence did not satisfy strict gates");
}

function assertProjectionDriftBlocks(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	writeFileSync(join(cwd, instructionProjectionPath(input.host)), "local drift\n");
	try {
		startPavedaDo({
			cwd,
			host: input.host,
			profile: input.profile,
			objective: "Conformance drift task",
			taskType: "docs",
			now: input.now,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Projection drift blocks run")) {
			return pass(DRIFT_FIXTURE, "generated projection drift blocks run start");
		}
		throw error;
	}
	throw new Error("projection drift did not block run start");
}

function assertReleaseMissingGatesBlocks(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: "release",
		objective: "Conformance release task without release gates",
		taskType: "code",
		acceptanceCriteria: ["release gates must block when evidence is missing"],
		now: input.now,
	});
	const verified = verifyRun({
		cwd,
		runId: started.run.runId,
		profile: "release",
		now: input.now + 1,
	});
	const blockedGateIds = verified.gates
		.filter((gate) => gate.status === "block")
		.map((gate) => gate.id);
	if (
		!verified.ok &&
		blockedGateIds.includes("release-signoff") &&
		blockedGateIds.includes("full-conformance") &&
		blockedGateIds.includes("immutable-artifact-retention")
	) {
		return pass(RELEASE_MISSING_GATES_FIXTURE, "release task blocks without release gates", {
			runId: started.run.runId,
			blockedGateIds,
		});
	}
	throw new Error("release task did not block missing release gates");
}

function assertReleaseFullEvidencePasses(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: "release",
		objective: "Conformance release task with complete evidence",
		taskType: "code",
		acceptanceCriteria: ["complete release evidence satisfies every required gate"],
		now: input.now,
	});
	const artifact = writeReleaseConformanceArtifact(cwd, started.run.runId, input.now + 1);
	recordReleaseEvidence(cwd, started.run.runId, artifact.id, input.now + 2);
	const verified = verifyRun({
		cwd,
		runId: started.run.runId,
		profile: "release",
		now: input.now + 3,
	});
	if (verified.ok && verified.scoreSummary.blockedGates === 0) {
		return pass(RELEASE_FULL_EVIDENCE_FIXTURE, "complete release evidence satisfies gates", {
			runId: started.run.runId,
			scoreSummary: verified.scoreSummary,
		});
	}
	throw new Error("complete release evidence did not satisfy release gates");
}

function assertClaudeLifecycleCapture(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Claude lifecycle conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromClaudeCodeHookPayload({
				hook_event_name: "SessionStart",
				session_id: "conformance-claude-session",
				cwd,
				paveda_run_id: started.run.runId,
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		if (
			captured.hostLifecycle?.status === "recorded" &&
			captured.hostLifecycle.hostEvent?.eventType === "claude.session.started"
		) {
			return pass(CLAUDE_LIFECYCLE_FIXTURE, "Claude hook lifecycle event was captured", {
				runId: started.run.runId,
			});
		}
		throw new Error("Claude lifecycle event was not recorded");
	} finally {
		store.close();
	}
}

function assertClaudeBashCommandEvidence(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Claude Bash evidence conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromClaudeCodeHookPayload({
				hook_event_name: "PostToolUse",
				session_id: "conformance-claude-bash",
				cwd,
				paveda_run_id: started.run.runId,
				tool_use_id: "conformance",
				tool_name: "Bash",
				tool_input: { command: "pnpm test" },
				tool_response: { exit_code: 0 },
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		const summary = summarizeRun({ cwd, runId: started.run.runId });
		if (
			captured.hostLifecycle?.evidence?.evidenceId === "claude-bash-conformance" &&
			summary.evidence.some((evidence) => evidence.evidenceId === "claude-bash-conformance")
		) {
			return pass(CLAUDE_BASH_EVIDENCE_FIXTURE, "Claude Bash hook recorded command evidence", {
				runId: started.run.runId,
			});
		}
		throw new Error("Claude Bash command evidence was not recorded");
	} finally {
		store.close();
	}
}

function assertCodexGoalHandoff(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Codex goal handoff conformance",
		taskType: "docs",
		now: input.now,
	});
	const summary = summarizeRun({ cwd, runId: started.run.runId });
	if (
		started.hostNative.status === "native_handoff" &&
		started.hostNative.primitive === "goal" &&
		summary.hostEvents.some((event) => event.eventType === "codex.goal.created")
	) {
		return pass(CODEX_HANDOFF_FIXTURE, "Codex native goal handoff was recorded", {
			runId: started.run.runId,
		});
	}
	throw new Error("Codex native goal handoff was not recorded");
}

function assertCodexStatusMapping(input: FixtureInput): ConformanceFixtureResult {
	const completed = normalizeCodexGoalLifecycleEvent({ nativeStatus: "completed" });
	const blocked = normalizeCodexGoalLifecycleEvent({ nativeStatus: "blocked" });
	if (
		completed.eventType === "codex.goal.completed" &&
		completed.normalizedStatus === "completed" &&
		blocked.eventType === "codex.goal.blocked" &&
		blocked.normalizedStatus === "blocked"
	) {
		return pass(CODEX_STATUS_FIXTURE, "Codex native goal statuses normalize to Paveda status");
	}
	throw new Error("Codex native goal status mapping failed");
}

function assertPiLifecycleCapture(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Pi lifecycle conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromPiHookPayload({
				event_name: "session_start",
				session_id: "conformance-pi-session",
				cwd,
				paveda_run_id: started.run.runId,
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		if (
			captured.hostLifecycle?.status === "recorded" &&
			captured.hostLifecycle.hostEvent?.eventType === "pi.session.started"
		) {
			return pass(PI_LIFECYCLE_FIXTURE, "Pi hook lifecycle event was captured", {
				runId: started.run.runId,
			});
		}
		throw new Error("Pi lifecycle event was not recorded");
	} finally {
		store.close();
	}
}

function assertPiCommandEvidence(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Pi command evidence conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromPiHookPayload({
				event_name: "tool_result",
				session_id: "conformance-pi-bash",
				cwd,
				paveda_run_id: started.run.runId,
				tool_use_id: "conformance",
				toolName: "bash",
				input: { command: "pnpm test" },
				result: { exit_code: 0 },
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		const summary = summarizeRun({ cwd, runId: started.run.runId });
		if (
			captured.hostLifecycle?.evidence?.evidenceId === "pi-bash-conformance" &&
			summary.evidence.some((evidence) => evidence.evidenceId === "pi-bash-conformance")
		) {
			return pass(PI_COMMAND_EVIDENCE_FIXTURE, "Pi hook recorded command evidence", {
				runId: started.run.runId,
			});
		}
		throw new Error("Pi command evidence was not recorded");
	} finally {
		store.close();
	}
}

function assertHermesLifecycleCapture(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Hermes lifecycle conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromHermesHookPayload({
				hook_event_name: "on_session_start",
				session_id: "conformance-hermes-session",
				cwd,
				paveda_run_id: started.run.runId,
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		if (
			captured.hostLifecycle?.status === "recorded" &&
			captured.hostLifecycle.hostEvent?.eventType === "hermes.session.started"
		) {
			return pass(HERMES_LIFECYCLE_FIXTURE, "Hermes hook lifecycle event was captured", {
				runId: started.run.runId,
			});
		}
		throw new Error("Hermes lifecycle event was not recorded");
	} finally {
		store.close();
	}
}

function assertHermesCommandEvidence(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	const started = startPavedaDo({
		cwd,
		host: input.host,
		profile: input.profile,
		objective: "Hermes command evidence conformance",
		taskType: "docs",
		now: input.now,
	});
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		const captured = dispatchHookEvent(store, {
			...fromHermesHookPayload({
				hook_event_name: "transform_terminal_output",
				session_id: "conformance-hermes-bash",
				cwd,
				paveda_run_id: started.run.runId,
				tool_use_id: "conformance",
				command: "pnpm test",
				output: "pass",
				exit_code: 0,
			}),
			ts: input.now + 1,
			projectHooks: false,
		});
		const summary = summarizeRun({ cwd, runId: started.run.runId });
		if (
			captured.hostLifecycle?.evidence?.evidenceId === "hermes-bash-conformance" &&
			summary.evidence.some((evidence) => evidence.evidenceId === "hermes-bash-conformance")
		) {
			return pass(HERMES_COMMAND_EVIDENCE_FIXTURE, "Hermes hook recorded command evidence", {
				runId: started.run.runId,
			});
		}
		throw new Error("Hermes command evidence was not recorded");
	} finally {
		store.close();
	}
}

interface FixtureInput {
	fixtureId: string;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
	root: string;
	now: number;
}

function createFixtureProject(input: FixtureInput): string {
	const cwd = mkdtempSync(join(input.root, `${input.fixtureId}-`));
	initializePaveda({ host: input.host, cwd, skills: ["do"], write: true, force: true });
	return cwd;
}

function writeReleaseConformanceArtifact(cwd: string, runId: string, now: number) {
	const store = new EventStore(resolveStorePath("project", cwd));
	try {
		return store.writeArtifact({
			runId,
			kind: "release-trace",
			fileName: "release-retention.txt",
			content: "release conformance artifact\n",
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

function recordReleaseEvidence(cwd: string, runId: string, artifactId: number, now: number): void {
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
			{ reviewedBy: "conformance", residualRisk: "low", riskSurfaces: ["mixed"] },
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
			{ releaseSignoff: true, approvedBy: "conformance" },
		],
		[
			"full-conformance-pass",
			"handoff",
			"host_event",
			null,
			null,
			{ conformanceOk: true, fixturesPassed: ["release-full-evidence-passes"] },
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
			rationale: `${kind} passed for release conformance fixture.`,
			metadata,
			now: now + index,
		});
	}
}

function instructionProjectionPath(host: HostSkillBundleTarget): string {
	switch (host) {
		case "harness":
			return ".harness/AGENTS.md";
		case "claude-code":
			return ".claude/CLAUDE.md";
		case "codex":
			return "AGENTS.md";
		case "pi":
			return ".pi/AGENTS.md";
		case "hermes":
			return ".hermes/AGENTS.md";
	}
}

function pass(id: string, message: string, details?: unknown): ConformanceFixtureResult {
	return {
		id,
		status: "pass",
		message,
		...(details ? { details } : {}),
	};
}
