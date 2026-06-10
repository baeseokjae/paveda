import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fromClaudeCodeHookPayload } from "../adapters/claude-code/index.js";
import { normalizeCodexGoalLifecycleEvent } from "../adapters/codex/index.js";
import { loadHostCapabilities, parsePavedaProfileValue } from "../contract/index.js";
import {
	addRunEvidence,
	runHostCommand,
	startPavedaDo,
	summarizeRun,
	verifyRun,
} from "../execution/index.js";
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
const RELEASE_FIXTURE = "release-not-supported";
const CLAUDE_LIFECYCLE_FIXTURE = "claude-hook-lifecycle-capture";
const CLAUDE_BASH_EVIDENCE_FIXTURE = "claude-bash-command-evidence";
const CODEX_HANDOFF_FIXTURE = "codex-goal-lifecycle-handoff";
const CODEX_STATUS_FIXTURE = "codex-native-goal-status-mapping";

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
			case RELEASE_FIXTURE:
				return assertReleaseNotSupported(input);
			case CLAUDE_LIFECYCLE_FIXTURE:
				return assertClaudeLifecycleCapture(input);
			case CLAUDE_BASH_EVIDENCE_FIXTURE:
				return assertClaudeBashCommandEvidence(input);
			case CODEX_HANDOFF_FIXTURE:
				return assertCodexGoalHandoff(input);
			case CODEX_STATUS_FIXTURE:
				return assertCodexStatusMapping(input);
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

function assertReleaseNotSupported(input: FixtureInput): ConformanceFixtureResult {
	const cwd = createFixtureProject(input);
	try {
		runHostCommand({
			cwd,
			host: input.host,
			profile: "release",
			nativeArgs: [process.execPath, "-e", "process.exit(0)"],
			now: input.now,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("not_supported_in_mvp")) {
			return pass(RELEASE_FIXTURE, "release profile execution blocks early in MVP");
		}
		throw error;
	}
	throw new Error("release profile execution did not block");
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
