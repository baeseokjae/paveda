import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { type CodexGoalHandoff, buildCodexGoalHandoff } from "../adapters/codex/index.js";
import {
	type ContractValidationResult,
	assertExecutableProfile,
	loadHostCapabilities,
	loadProfileManifest,
	loadScoreMetrics,
	parsePavedaProfileValue,
	validateContractSource,
} from "../contract/index.js";
import type { HostSkillBundleTarget } from "../host-bundles/index.js";
import { parseHostSkillBundleTarget } from "../host-bundles/index.js";
import { type ProjectionStatusResult, checkProjectionStatus } from "../projection/index.js";
import {
	type GateSummary,
	type ScoreMetricDefinition,
	type ScoreThreshold,
	evaluateScoreMetric,
} from "../score-evaluator/index.js";
import {
	type ArtifactRecord,
	type DecisionRecord,
	EventStore,
	type EvidenceRecord,
	type EvidenceResult,
	type HostEventRecord,
	type IterationFingerprintRecord,
	type PavedaProfile,
	type PhaseEventRecord,
	type PolicyViolationRecord,
	type RunRecord,
	type ScoreRecord,
	type StoreScope,
	resolveStorePath,
} from "../store/index.js";

export type PavedaTaskType =
	| "code"
	| "ui"
	| "api"
	| "data"
	| "infra"
	| "test"
	| "docs"
	| "metadata"
	| "mixed"
	| "command";

export type RiskSurface =
	| "auth"
	| "payment"
	| "data"
	| "infra"
	| "public-api"
	| "ui-only"
	| "docs-only"
	| "mixed";

export interface StartPavedaDoOptions {
	cwd?: string;
	host?: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	objective: string;
	taskType?: PavedaTaskType | string;
	acceptanceCriteria?: string[];
	fromSpec?: string;
	ambiguityScore?: number;
	changedFiles?: string[];
	riskSurfaces?: RiskSurface[] | string[];
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface StartPavedaDoResult {
	cwd: string;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
	run: RunRecord;
	validation: ContractValidationResult;
	projectionStatus: ProjectionStatusResult;
	hostNative: StartHostNativeResult;
	nextCommands: string[];
}

export type StartHostNativeResult =
	| {
			status: "pending_adapter";
			message: string;
	  }
	| HookLifecycleHandoff
	| CodexGoalHandoff;

export interface HookLifecycleHandoff {
	status: "native_handoff";
	primitive: "hook_lifecycle";
	eventType: string;
	phaseId: "intake";
	normalizedStatus: "active";
	message: string;
	payload: Record<string, unknown>;
}

export interface RunHostCommandOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	objective?: string;
	taskType?: PavedaTaskType | string;
	acceptanceCriteria?: string[];
	fromSpec?: string;
	ambiguityScore?: number;
	nativeArgs: string[];
	changedFiles?: string[];
	riskSurfaces?: RiskSurface[] | string[];
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface RunHostCommandResult {
	cwd: string;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
	run: RunRecord;
	command: string[];
	exitCode: number;
	signal: string | null;
	stdoutArtifact: ArtifactRecord | null;
	stderrArtifact: ArtifactRecord | null;
	evidence: EvidenceRecord;
	validation: ContractValidationResult;
	projectionStatus: ProjectionStatusResult;
}

export interface AddEvidenceOptions {
	cwd?: string;
	runId: string;
	phaseId?: string | null;
	evidenceId: string;
	kind: string;
	result: string;
	command?: string | null;
	exitCode?: number | null;
	artifactId?: number | null;
	rationale?: string | null;
	metadata?: unknown;
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface RunStatusResult {
	run: RunRecord;
	phaseEvents: PhaseEventRecord[];
	evidence: EvidenceRecord[];
	artifacts: ArtifactRecord[];
	hostEvents: HostEventRecord[];
	scores: ScoreRecord[];
	decisions: DecisionRecord[];
	iterationFingerprints: IterationFingerprintRecord[];
	stagnation: StagnationState | null;
	policyViolations: PolicyViolationRecord[];
}

export type StagnationPattern = "spinning" | "oscillation" | "no_drift" | "diminishing_returns";

export interface StagnationState {
	pattern: StagnationPattern;
	runId: string;
	phaseId: string;
	iterations: number[];
	severity: "warning" | "block";
	policyId: "workflow.stagnation.recovery-required";
	message: string;
	recovery: string;
	nextCommand: string;
}

export type RunSpecBindingSourceType = "inline" | "spec_file" | "contract_source" | "host_goal";

export interface RunSpecBinding {
	schemaVersion: 1;
	bindingId: string;
	sourceType: RunSpecBindingSourceType;
	sourcePath?: string;
	specSha256?: string;
	acceptanceSha256: string;
	ambiguityScore?: number;
	contractVersion?: string;
	profile: PavedaProfile;
	createdAt: number;
}

export interface VerifyRunOptions {
	cwd?: string;
	runId: string;
	profile?: PavedaProfile | string;
	stage?: VerificationStage | string;
	task?: string;
	write?: boolean;
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface VerifyRunResult {
	cwd: string;
	runId: string;
	profile: PavedaProfile;
	taskType: PavedaTaskType;
	ok: boolean;
	gates: VerifyGateResult[];
	stages: VerificationStageResult[];
	ladder: VerifyLadderStepResult[];
	scoreSummary: VerificationScoreSummary;
	score: ScoreRecord | null;
	allScores: ScoreRecord[];
	policyViolations: PolicyViolationRecord[];
}

export type VerificationStage = "mechanical" | "semantic" | "consensus" | "review";

export interface VerificationStageResult {
	stage: VerificationStage;
	result: EvidenceResult;
	score?: number;
	confidence?: number;
	required: boolean;
	triggeredBy: string[];
	evidenceIds: number[];
	blockingPolicyViolationIds: number[];
	nextCommand?: string;
}

export interface VerifyGateResult {
	id: string;
	policyId?: string;
	phase: string;
	evidenceKind: string;
	status: "pass" | "warn" | "block" | "not_applicable";
	message: string;
	evidenceIds: number[];
	recovery: VerifyGateRecovery | null;
}

export interface VerifyGateRecovery {
	action:
		| "record_pass_evidence"
		| "record_not_applicable"
		| "ask_setup_sprint"
		| "repair_then_block";
	message: string;
}

export interface VerifyLadderStepResult {
	evidenceKind: string;
	status: "pass" | "warn" | "block" | "not_applicable" | "not_required";
	requiredGateIds: string[];
	evidenceIds: number[];
	message: string;
}

export interface VerificationScoreSummary {
	metric: "verification_score";
	value: number;
	threshold: number;
	decision: "pass" | "block";
	requiredGates: number;
	passedGates: number;
	notApplicableGates: number;
	blockedGates: number;
}

interface RequiredGate {
	id?: unknown;
	phase?: unknown;
	evidenceKind?: unknown;
	requiredForTaskTypes?: unknown;
	capability?: unknown;
	missingCapabilityBehavior?: unknown;
	failureBehavior?: unknown;
	notApplicablePolicy?: {
		allowed?: unknown;
		requiresRationale?: unknown;
		requiresClassifierReason?: unknown;
		requiresUserApproval?: unknown;
	};
	metadata?: unknown;
}

interface ProfileManifest {
	requiredGates?: unknown[];
	scoreThresholds?: unknown[];
	verificationLadder?: unknown[];
	verificationStages?: unknown[];
	notApplicablePolicy?: {
		allowedTaskTypes?: unknown;
		requiresRationale?: unknown;
		requiresClassifierReason?: unknown;
	};
}

interface ProfileNotApplicablePolicy {
	allowedTaskTypes: string[];
	requiresRationale: boolean;
	requiresClassifierReason: boolean;
}

interface HostCapabilityEntry {
	id: string;
	support: string;
	confidence: number;
	source: string;
}

interface VerifyGateContext {
	profile: PavedaProfile;
	evidence: readonly EvidenceRecord[];
	artifacts: readonly ArtifactRecord[];
	hostEvents: readonly HostEventRecord[];
	decisions: readonly DecisionRecord[];
	taskType: PavedaTaskType;
	profilePolicy: ProfileNotApplicablePolicy;
	riskSurfaces: RiskSurface[];
	hostCapabilities: readonly HostCapabilityEntry[];
}

const DEFAULT_HOST: HostSkillBundleTarget = "codex";
const DEFAULT_TASK_TYPE: PavedaTaskType = "code";
const SUCCESS_EXIT_CODE = 0;

export function startPavedaDo(options: StartPavedaDoOptions): StartPavedaDoResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = options.host ? parseHostSkillBundleTarget(options.host) : DEFAULT_HOST;
	const profile = parsePavedaProfileValue(options.profile);
	assertExecutableProfile(cwd, profile);
	const taskType = parseTaskType(options.taskType ?? DEFAULT_TASK_TYPE);
	const validation = requireRunnableContract({ cwd, host, profile });
	const projectionStatus = requireCleanProjection({ cwd, host });
	const now = options.now ?? Date.now();
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);

	try {
		const hostNativePrimitive = readHostNativePrimitive(host);
		const specBinding = buildRunSpecBinding({
			cwd,
			sourcePath: options.fromSpec,
			acceptanceCriteria: options.acceptanceCriteria ?? [],
			ambiguityScore: options.ambiguityScore,
			profile,
			createdAt: now,
		});
		const run = store.createRun({
			objective: options.objective,
			acceptanceCriteria: options.acceptanceCriteria ?? [],
			profile,
			host,
			context: {
				taskType,
				entrypoint: "paveda do",
				hostNativePrimitive,
				changedFiles: options.changedFiles ?? [],
				riskSurfaces: normalizeRiskSurfaces(options.riskSurfaces),
			},
			metadata: {
				specBinding,
			},
			ts: now,
		});
		recordCapabilities(store, run.runId, host, cwd, now);
		store.upsertPhase({
			runId: run.runId,
			phaseId: "intake",
			status: "completed",
			startedAt: now,
			endedAt: now,
			hostMapping: { entrypoint: "paveda do", hostNativePrimitive },
		});
		store.appendPhaseEvent({
			runId: run.runId,
			phaseId: "intake",
			eventType: "run.created",
			status: "completed",
			payload: { taskType, profile, host },
			ts: now,
		});
		store.recordDecision({
			runId: run.runId,
			phaseId: "intake",
			decisionType: "workflow.spec-binding.recorded",
			decision: specBinding.bindingId,
			rationale: "Run bound to spec and acceptance criteria at intake.",
			ts: now,
		});
		const hostNative = recordHostNativeStart(store, {
			run,
			host,
			taskType,
			cwd,
			ts: now,
		});

		return {
			cwd,
			host,
			profile,
			run: store.getRun(run.runId) ?? run,
			validation,
			projectionStatus,
			hostNative,
			nextCommands: [
				`paveda status --run ${run.runId}`,
				`paveda evidence --run ${run.runId}`,
				`paveda verify --run ${run.runId} --profile ${profile}`,
			],
		};
	} finally {
		store.close();
	}
}

function recordHostNativeStart(
	store: EventStore,
	input: {
		run: RunRecord;
		host: HostSkillBundleTarget;
		taskType: PavedaTaskType;
		cwd: string;
		ts: number;
	},
): StartHostNativeResult {
	if (input.host === "codex") {
		const handoff = buildCodexGoalHandoff({
			run: input.run,
			taskType: input.taskType,
			cwd: input.cwd,
		});
		store.appendHostEvent({
			runId: input.run.runId,
			host: input.host,
			eventType: handoff.eventType,
			normalizedStatus: handoff.normalizedStatus,
			payload: handoff.payload,
			ts: input.ts,
		});
		store.appendPhaseEvent({
			runId: input.run.runId,
			phaseId: handoff.phaseId,
			eventType: handoff.eventType,
			status: handoff.normalizedStatus,
			payload: {
				host: input.host,
				...handoff.payload,
			},
			ts: input.ts,
		});
		return handoff;
	}

	if (input.host === "pi" || input.host === "hermes") {
		const handoff = buildHookLifecycleHandoff({ ...input, host: input.host });
		store.appendHostEvent({
			runId: input.run.runId,
			host: input.host,
			eventType: handoff.eventType,
			normalizedStatus: handoff.normalizedStatus,
			payload: handoff.payload,
			ts: input.ts,
		});
		store.appendPhaseEvent({
			runId: input.run.runId,
			phaseId: handoff.phaseId,
			eventType: handoff.eventType,
			status: handoff.normalizedStatus,
			payload: {
				host: input.host,
				...handoff.payload,
			},
			ts: input.ts,
		});
		return handoff;
	}

	store.appendHostEvent({
		runId: input.run.runId,
		host: input.host,
		eventType: "host_native.pending_adapter",
		normalizedStatus: "pending",
		payload: {
			message: "Deep host adapter startRun is scheduled for a later phase.",
		},
		ts: input.ts,
	});
	return {
		status: "pending_adapter",
		message: "Paveda recorded the run and contract handoff; this host adapter is not deep yet.",
	};
}

function readHostNativePrimitive(host: HostSkillBundleTarget): string {
	if (host === "codex") {
		return "goal";
	}
	if (host === "pi" || host === "hermes") {
		return "hook_lifecycle";
	}
	return "pending_adapter";
}

function buildHookLifecycleHandoff(input: {
	run: RunRecord;
	host: "pi" | "hermes";
	taskType: PavedaTaskType;
	cwd: string;
}): HookLifecycleHandoff {
	return {
		status: "native_handoff",
		primitive: "hook_lifecycle",
		eventType: `${input.host}.lifecycle.handoff.created`,
		phaseId: "intake",
		normalizedStatus: "active",
		message: `${input.host} hook lifecycle handoff recorded. Continue in the host native loop and let Paveda hooks capture phase and evidence events.`,
		payload: {
			nativeStatus: "created",
			primitive: "hook_lifecycle",
			objective: input.run.objective,
			acceptanceCriteria: input.run.acceptanceCriteria,
			taskType: input.taskType,
			profile: input.run.profile,
			cwd: input.cwd,
		},
	};
}

function buildCommandArtifactMetadata(
	profile: PavedaProfile,
	command: readonly string[],
	createdAt: number,
): Record<string, unknown> {
	const metadata: Record<string, unknown> = { command };
	if (profile === "release") {
		metadata.releaseRetention = {
			policy: "release",
			mode: "immutable",
			immutable: true,
			redactionStatus: "not_required",
			capturedAt: createdAt,
		};
	}
	return metadata;
}

export function runHostCommand(options: RunHostCommandOptions): RunHostCommandResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfileValue(options.profile);
	assertExecutableProfile(cwd, profile);
	const taskType = parseTaskType(options.taskType ?? "command");
	if (options.nativeArgs.length === 0) {
		throw new Error("Missing native command after --");
	}
	const validation = requireRunnableContract({ cwd, host, profile });
	const projectionStatus = requireCleanProjection({ cwd, host });
	const now = options.now ?? Date.now();
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);

	try {
		const acceptanceCriteria = options.acceptanceCriteria ?? [];
		const specBinding = buildRunSpecBinding({
			cwd,
			sourcePath: options.fromSpec,
			acceptanceCriteria,
			ambiguityScore: options.ambiguityScore,
			profile,
			createdAt: now,
		});
		const run = store.createRun({
			objective: options.objective ?? options.nativeArgs.join(" "),
			acceptanceCriteria,
			profile,
			host,
			context: {
				taskType,
				entrypoint: "paveda run",
				command: options.nativeArgs,
				changedFiles: options.changedFiles ?? [],
				riskSurfaces: normalizeRiskSurfaces(options.riskSurfaces),
			},
			metadata: {
				specBinding,
			},
			ts: now,
		});
		recordCapabilities(store, run.runId, host, cwd, now);
		store.upsertPhase({
			runId: run.runId,
			phaseId: "execute",
			status: "active",
			startedAt: now,
			hostMapping: { entrypoint: "paveda run", command: options.nativeArgs },
		});
		store.appendPhaseEvent({
			runId: run.runId,
			phaseId: "execute",
			eventType: "command.started",
			status: "active",
			payload: { command: options.nativeArgs },
			ts: now,
		});
		store.appendHostEvent({
			runId: run.runId,
			host,
			eventType: "command.started",
			normalizedStatus: "active",
			payload: { command: options.nativeArgs },
			ts: now,
		});
		store.recordDecision({
			runId: run.runId,
			phaseId: "execute",
			decisionType: "workflow.spec-binding.recorded",
			decision: specBinding.bindingId,
			rationale: "Run bound to spec and acceptance criteria before native command execution.",
			ts: now,
		});

		const spawned = spawnSync(options.nativeArgs[0] ?? "", options.nativeArgs.slice(1), {
			cwd,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
		});
		const exitCode = normalizeExitCode(spawned.status, spawned.error);
		const endedAt = Date.now();
		const stdout = spawned.stdout ?? "";
		const stderr = spawned.error
			? `${spawned.error.message}\n${spawned.stderr ?? ""}`
			: (spawned.stderr ?? "");
		const artifactMetadata = buildCommandArtifactMetadata(profile, options.nativeArgs, endedAt);
		const stdoutArtifact =
			stdout.length > 0
				? store.writeArtifact({
						runId: run.runId,
						kind: "command-stdout",
						fileName: "stdout.txt",
						content: stdout,
						metadata: artifactMetadata,
						createdAt: endedAt,
					})
				: null;
		const stderrArtifact =
			stderr.length > 0
				? store.writeArtifact({
						runId: run.runId,
						kind: "command-stderr",
						fileName: "stderr.txt",
						content: stderr,
						metadata: artifactMetadata,
						createdAt: endedAt,
					})
				: null;
		const evidence = store.recordEvidence({
			runId: run.runId,
			phaseId: "execute",
			evidenceId: "native-command",
			kind: "command",
			result: exitCode === SUCCESS_EXIT_CODE ? "pass" : "fail",
			command: options.nativeArgs.join(" "),
			exitCode,
			artifactId: stdoutArtifact?.id ?? stderrArtifact?.id ?? null,
			rationale:
				exitCode === SUCCESS_EXIT_CODE
					? "host-native command exited successfully"
					: "host-native command exited with failure",
			metadata: {
				signal: spawned.signal ?? null,
				stdoutArtifactId: stdoutArtifact?.id ?? null,
				stderrArtifactId: stderrArtifact?.id ?? null,
			},
			ts: endedAt,
		});
		store.appendPhaseEvent({
			runId: run.runId,
			phaseId: "execute",
			eventType: exitCode === SUCCESS_EXIT_CODE ? "command.completed" : "command.failed",
			status: exitCode === SUCCESS_EXIT_CODE ? "completed" : "failed",
			payload: { exitCode, signal: spawned.signal ?? null },
			ts: endedAt,
		});
		store.upsertPhase({
			runId: run.runId,
			phaseId: "execute",
			status: exitCode === SUCCESS_EXIT_CODE ? "completed" : "failed",
			endedAt,
			hostMapping: { entrypoint: "paveda run", command: options.nativeArgs },
		});
		store.appendHostEvent({
			runId: run.runId,
			host,
			eventType: exitCode === SUCCESS_EXIT_CODE ? "command.completed" : "command.failed",
			normalizedStatus: exitCode === SUCCESS_EXIT_CODE ? "completed" : "failed",
			payload: { exitCode, signal: spawned.signal ?? null },
			ts: endedAt,
		});
		const completedRun = store.completeRun(
			run.runId,
			exitCode === SUCCESS_EXIT_CODE ? "completed" : "failed",
			endedAt,
		);

		return {
			cwd,
			host,
			profile,
			run: completedRun,
			command: options.nativeArgs,
			exitCode,
			signal: spawned.signal ?? null,
			stdoutArtifact,
			stderrArtifact,
			evidence,
			validation,
			projectionStatus,
		};
	} finally {
		store.close();
	}
}

export function addRunEvidence(options: AddEvidenceOptions): EvidenceRecord {
	const cwd = resolve(options.cwd ?? process.cwd());
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const evidence = store.recordEvidence({
			runId: options.runId,
			phaseId: options.phaseId ?? null,
			evidenceId: options.evidenceId,
			kind: options.kind,
			result: parseEvidenceResult(options.result),
			command: options.command ?? null,
			exitCode: options.exitCode ?? null,
			artifactId: options.artifactId ?? null,
			rationale: options.rationale ?? null,
			metadata: options.metadata,
			ts: options.now ?? Date.now(),
		});
		const fingerprint = readIterationFingerprintMetadata(options.metadata);
		if (fingerprint) {
			store.recordIterationFingerprint({
				runId: options.runId,
				phaseId: fingerprint.phaseId ?? options.phaseId ?? "execute",
				iteration: fingerprint.iteration,
				outputHash: fingerprint.outputHash,
				diffHash: fingerprint.diffHash,
				failureFingerprint: fingerprint.failureFingerprint,
				verificationScore: fingerprint.verificationScore,
				taxonomy: fingerprint.taxonomy,
				ts: options.now ?? Date.now(),
			});
		}
		return evidence;
	} finally {
		store.close();
	}
}

export function summarizeRun(options: {
	cwd?: string;
	runId: string;
	dbPath?: string;
	storeScope?: StoreScope;
}): RunStatusResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const run = store.getRun(options.runId);
		if (!run) {
			throw new Error(`Run does not exist: ${options.runId}`);
		}
		const iterationFingerprints = store.listIterationFingerprints(options.runId);
		const stagnation = detectStagnation(run, iterationFingerprints);
		return {
			run,
			phaseEvents: store.listPhaseEvents(options.runId),
			evidence: store.listEvidence(options.runId),
			artifacts: store.listArtifacts(options.runId),
			hostEvents: store.listHostEvents(options.runId),
			scores: store.listScores(options.runId),
			decisions: store.listDecisions(options.runId),
			iterationFingerprints,
			stagnation,
			policyViolations: store.listPolicyViolations(options.runId),
		};
	} finally {
		store.close();
	}
}

export function listRunEvidence(options: {
	cwd?: string;
	runId: string;
	dbPath?: string;
	storeScope?: StoreScope;
}): EvidenceRecord[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		return store.listEvidence(options.runId);
	} finally {
		store.close();
	}
}

export function verifyRun(options: VerifyRunOptions): VerifyRunResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const profile = parsePavedaProfileValue(options.profile);
	assertExecutableProfile(cwd, profile);
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const run = store.getRun(options.runId);
		if (!run) {
			throw new Error(`Run does not exist: ${options.runId}`);
		}
		const taskType = parseTaskType(readTaskType(run));
		const riskSurfaces = classifyRunRiskSurfaces(run);
		const evidence = options.task
			? store
					.listEvidence(run.runId)
					.filter((item) => evidenceMatchesTask(item, options.task ?? ""))
			: store.listEvidence(run.runId);
		const artifacts = store.listArtifacts(run.runId);
		const hostEvents = store.listHostEvents(run.runId);
		const decisions = store.listDecisions(run.runId);
		const iterationFingerprints = store.listIterationFingerprints(run.runId);
		const stagnation = detectStagnation(run, iterationFingerprints);
		const manifest = loadProfileManifest(cwd, profile);
		const profilePolicy = readProfileNotApplicablePolicy(manifest);
		const hostInfo = run.host ? loadHostCapabilities({ cwd, host: run.host }) : null;
		const hostCapabilities = (hostInfo?.capabilities ?? []) as HostCapabilityEntry[];
		const stageFilter = parseOptionalVerificationStage(options.stage);
		const gates = [
			...verifySpecBinding({ cwd, profile, run, taskType, store }),
			...verifyStagnation({ profile, stagnation }),
			...requiredGatesForTask(manifest, taskType, riskSurfaces).map((gate) =>
				verifyGate(gate, {
					profile,
					evidence,
					artifacts,
					hostEvents,
					decisions,
					taskType,
					profilePolicy,
					riskSurfaces,
					hostCapabilities,
				}),
			),
		];
		const scoreSummary = summarizeVerificationScore(gates, manifest);
		const ladder = buildVerificationLadder(manifest, gates, evidence);
		const ok =
			scoreSummary.decision === "pass" &&
			gates.every(
				(gate) =>
					gate.status === "pass" || gate.status === "warn" || gate.status === "not_applicable",
			);
		const now = options.now ?? Date.now();
		const policyViolations = options.write
			? [
					...gates
						.filter((gate) => gate.status === "block" || gate.status === "warn")
						.map((gate) =>
							store.recordPolicyViolation({
								runId: run.runId,
								policyId: gate.policyId ?? gate.id,
								severity: gate.status === "warn" ? "warning" : "error",
								message: gate.message,
								blocked: gate.status === "block",
								ts: now,
							}),
						),
					...(stagnation
						? [
								store.recordPolicyViolation({
									runId: run.runId,
									policyId: stagnation.policyId,
									severity: stagnation.severity,
									message: stagnation.message,
									blocked: stagnation.severity === "block",
									ts: now,
								}),
							]
						: []),
				]
			: [];
		const stages = buildVerificationStages({
			run,
			profile,
			gates,
			evidence,
			policyViolations,
			riskSurfaces,
			manifest,
			scores: store.listScores(run.runId),
			priorPolicyViolations: store.listPolicyViolations(run.runId),
		}).filter((stage) => (stageFilter ? stage.stage === stageFilter : true));
		if (options.write) {
			for (const stage of stages.filter((item) => item.stage === "review")) {
				store.append({
					sessionId: run.runId,
					ts: now,
					type: "review.stage",
					payload: stage,
				});
				store.append({
					sessionId: run.runId,
					ts: now,
					type: "review.severity",
					payload: {
						stage: stage.stage,
						severity:
							stage.result === "block" ? "high" : stage.result === "pass" ? "none" : "medium",
						result: stage.result,
						score: stage.score,
					},
				});
			}

			store.recordDecision({
				runId: run.runId,
				decisionType: "risk.surface",
				decision: riskSurfaces.join(","),
				rationale: `Risk surfaces classified for ${taskType} task: ${riskSurfaces.join(", ")}`,
				ts: now,
			});
		}
		const score = options.write
			? store.recordScore({
					runId: run.runId,
					metric: "verification_score",
					value: scoreSummary.value,
					decision: scoreSummary.decision,
					threshold: scoreSummary.threshold,
					rationale: ok
						? "required gates satisfied"
						: `required gates blocked: ${scoreSummary.blockedGates}`,
					ts: now,
				})
			: null;

		// Evaluate all contract-defined score metrics
		const metricDefs = loadScoreMetrics(cwd);
		const thresholds = (
			Array.isArray(manifest.scoreThresholds) ? manifest.scoreThresholds : []
		) as ScoreThreshold[];
		const gateSummaries: GateSummary[] = gates.map((g) => ({
			id: g.id,
			status: g.status,
			evidenceKind: g.evidenceKind,
			evidenceIds: g.evidenceIds,
		}));
		const phaseEvents = store.listPhaseEvents(run.runId);
		const phaseCount = new Set(phaseEvents.map((pe) => pe.phaseId)).size;
		const phaseCompletionRatio =
			phaseCount > 0
				? phaseEvents.filter((pe) => pe.status === "completed").length / phaseEvents.length
				: 0;
		const scoreContext = {
			evidence,
			gates: gateSummaries,
			scores: store.listScores(run.runId),
			taskType,
			riskSurfaces,
			changedFileCount: readChangedFileCount(run),
			phaseCompletionRatio,
		};
		const allScores: ScoreRecord[] = options.write ? [score].filter(isScoreRecord) : [];
		for (const rawDef of metricDefs) {
			const def = asScoreMetricDefinition(rawDef);
			if (!def) continue;
			const rawThreshold = thresholds.find((t) => t.metric === def.id);
			if (!rawThreshold) continue;
			const threshold = asScoreThreshold(rawThreshold);
			if (!threshold) continue;
			// Don't double-record verification_score
			if (def.id === "verification_score") continue;
			const result = evaluateScoreMetric(def, threshold, scoreContext);
			if (options.write) {
				allScores.push(
					store.recordScore({
						runId: run.runId,
						metric: result.metric,
						value: result.value,
						decision: result.decision,
						threshold: result.threshold,
						rationale: `score=${result.value.toFixed(3)} kind=${result.kind}`,
						ts: now,
					}),
				);
			}
		}
		if (!ok && options.write) {
			store.completeRun(run.runId, "blocked", now);
		}

		return {
			cwd,
			runId: run.runId,
			profile,
			taskType,
			ok,
			gates,
			stages,
			ladder,
			scoreSummary,
			score,
			allScores,
			policyViolations,
		};
	} finally {
		store.close();
	}
}

export function readRunSpecBinding(run: RunRecord): RunSpecBinding | null {
	const metadata = asRecord(run.metadata);
	const candidate = asRecord(metadata?.specBinding);
	if (!candidate) {
		return null;
	}
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.bindingId !== "string" ||
		!isSpecBindingSourceType(candidate.sourceType) ||
		typeof candidate.acceptanceSha256 !== "string" ||
		!isPavedaProfile(candidate.profile) ||
		typeof candidate.createdAt !== "number"
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		bindingId: candidate.bindingId,
		sourceType: candidate.sourceType,
		...(typeof candidate.sourcePath === "string" ? { sourcePath: candidate.sourcePath } : {}),
		...(typeof candidate.specSha256 === "string" ? { specSha256: candidate.specSha256 } : {}),
		acceptanceSha256: candidate.acceptanceSha256,
		...(typeof candidate.ambiguityScore === "number"
			? { ambiguityScore: candidate.ambiguityScore }
			: {}),
		...(typeof candidate.contractVersion === "string"
			? { contractVersion: candidate.contractVersion }
			: {}),
		profile: candidate.profile,
		createdAt: candidate.createdAt,
	};
}

function buildRunSpecBinding(input: {
	cwd: string;
	sourcePath?: string;
	acceptanceCriteria: readonly string[];
	ambiguityScore?: number;
	profile: PavedaProfile;
	createdAt: number;
}): RunSpecBinding {
	const sourcePath = input.sourcePath ? resolve(input.cwd, input.sourcePath) : undefined;
	const sourceType: RunSpecBindingSourceType = sourcePath ? "spec_file" : "inline";
	const specSha256 = sourcePath ? sha256(readFileSync(sourcePath)) : undefined;
	const relativeSourcePath = sourcePath ? relative(input.cwd, sourcePath) : undefined;
	const acceptanceSha256 = sha256(canonicalJson([...input.acceptanceCriteria]));
	const bindingSeed = {
		sourceType,
		sourcePath: relativeSourcePath,
		specSha256,
		acceptanceSha256,
		ambiguityScore: input.ambiguityScore,
		contractVersion: `profile:${input.profile}`,
		profile: input.profile,
	};
	return {
		schemaVersion: 1,
		bindingId: sha256(canonicalJson(bindingSeed)),
		sourceType,
		...(relativeSourcePath ? { sourcePath: relativeSourcePath } : {}),
		...(specSha256 ? { specSha256 } : {}),
		acceptanceSha256,
		...(input.ambiguityScore !== undefined ? { ambiguityScore: input.ambiguityScore } : {}),
		contractVersion: `profile:${input.profile}`,
		profile: input.profile,
		createdAt: input.createdAt,
	};
}

function verifySpecBinding(input: {
	cwd: string;
	profile: PavedaProfile;
	run: RunRecord;
	taskType: PavedaTaskType;
	store?: EventStore;
}): VerifyGateResult[] {
	if (!isCodeChangingTask(input.taskType)) {
		return [];
	}
	const binding = readRunSpecBinding(input.run);
	if (!binding || isMissingInlineSpecBinding(binding, input.run)) {
		if (input.profile === "fast") {
			return [
				specBindingGate({
					policyId: "workflow.spec-binding.missing",
					status: "warn",
					message: "fast code-changing run has no stable spec binding",
					recovery:
						"Run paveda do with --from-spec or --acceptance so the run has a stable contract binding.",
				}),
			];
		}
		return input.profile === "strict" || input.profile === "release"
			? [
					specBindingGate({
						policyId: "workflow.spec-binding.missing",
						status: "block",
						message: "strict and release code-changing runs require a spec binding",
						recovery:
							"Run paveda do with --from-spec or --acceptance so the run has a stable contract binding.",
					}),
				]
			: [];
	}
	if (binding.sourceType === "spec_file" && binding.sourcePath && binding.specSha256) {
		const currentSha256 = sha256(readFileSync(resolve(input.cwd, binding.sourcePath)));
		if (currentSha256 !== binding.specSha256) {
			return [
				specBindingGate({
					policyId: "workflow.spec-binding.drift",
					status: "block",
					message: "source spec hash differs from the recorded run binding",
					recovery: "Create an approved revision event or start a new run from the updated spec.",
				}),
			];
		}
	}
	const ambiguityThreshold = ambiguityThresholdForProfile(input.profile);
	if (
		ambiguityThreshold !== null &&
		binding.ambiguityScore !== undefined &&
		binding.ambiguityScore > ambiguityThreshold
	) {
		const effectiveThreshold = input.store
			? ontologyBoostedAmbiguityThreshold(input.store, input.run.runId, ambiguityThreshold)
			: ambiguityThreshold;
		if (binding.ambiguityScore > effectiveThreshold) {
			return [
				specBindingGate({
					policyId: "workflow.spec-binding.ambiguous",
					status: "block",
					message: `ambiguity score ${binding.ambiguityScore} exceeds ${input.profile} threshold ${effectiveThreshold}`,
					recovery:
						"Clarify the spec with /specify and start a new run with the lower ambiguity score.",
				}),
			];
		}
	}
	return [
		specBindingGate({
			policyId: "workflow.spec-binding.recorded",
			status: "pass",
			message: `run bound to ${binding.sourceType} ${binding.bindingId}`,
			recovery: null,
		}),
	];
}

function isMissingInlineSpecBinding(binding: RunSpecBinding, run: RunRecord): boolean {
	return binding.sourceType === "inline" && readStringArray(run.acceptanceCriteria).length === 0;
}

function verifyStagnation(input: {
	profile: PavedaProfile;
	stagnation: StagnationState | null;
}): VerifyGateResult[] {
	if (!input.stagnation || input.stagnation.severity !== "block") {
		return [];
	}
	return [
		{
			id: "stagnation-gate",
			policyId: input.stagnation.policyId,
			phase: input.stagnation.phaseId,
			evidenceKind: "iteration_fingerprint",
			status: "block",
			message: input.stagnation.message,
			evidenceIds: [],
			recovery: {
				action: "repair_then_block",
				message: input.stagnation.recovery,
			},
		},
	];
}

function detectStagnation(
	run: RunRecord,
	fingerprints: readonly IterationFingerprintRecord[],
): StagnationState | null {
	if (fingerprints.length < 3) {
		return null;
	}
	const byPhase = new Map<string, IterationFingerprintRecord[]>();
	for (const fingerprint of fingerprints) {
		const items = byPhase.get(fingerprint.phaseId) ?? [];
		items.push(fingerprint);
		byPhase.set(fingerprint.phaseId, items);
	}
	const phaseEntries = [...byPhase.entries()]
		.map(([phaseId, items]) => ({
			phaseId,
			items: [...items].sort((left, right) => left.iteration - right.iteration),
		}))
		.sort((left, right) => latestIteration(right.items) - latestIteration(left.items));
	for (const entry of phaseEntries) {
		const pattern = detectPhaseStagnation(entry.items);
		if (pattern) {
			const severity = run.profile === "strict" || run.profile === "release" ? "block" : "warning";
			const recovery = recoveryForStagnationPattern(pattern.pattern);
			return {
				pattern: pattern.pattern,
				runId: run.runId,
				phaseId: entry.phaseId,
				iterations: pattern.iterations,
				severity,
				policyId: "workflow.stagnation.recovery-required",
				message: `${pattern.pattern} detected across iterations ${pattern.iterations.join(", ")}`,
				recovery,
				nextCommand: `paveda evidence add --run ${run.runId} --phase ${entry.phaseId} --id stagnation-recovery --kind recovery_plan --result pass --rationale "${recovery}"`,
			};
		}
	}
	return null;
}

function detectPhaseStagnation(
	items: readonly IterationFingerprintRecord[],
): { pattern: StagnationPattern; iterations: number[] } | null {
	if (items.length < 3) {
		return null;
	}
	const last3 = items.slice(-3);
	const repeatedSignal = repeatedFingerprintSignal(last3);
	if (repeatedSignal) {
		return { pattern: "spinning", iterations: last3.map((item) => item.iteration) };
	}
	if (
		last3.every((item) => typeof item.verificationScore === "number") &&
		last3.every((item) => item.failureFingerprint === last3[0]?.failureFingerprint) &&
		Math.max(...last3.map((item) => item.verificationScore ?? 0)) -
			Math.min(...last3.map((item) => item.verificationScore ?? 0)) <=
			0.01
	) {
		return { pattern: "no_drift", iterations: last3.map((item) => item.iteration) };
	}
	if (items.length >= 4) {
		const last4 = items.slice(-4);
		const signals = last4.map(primaryFingerprintSignal);
		if (signals[0] && signals[1] && signals[0] === signals[2] && signals[1] === signals[3]) {
			return { pattern: "oscillation", iterations: last4.map((item) => item.iteration) };
		}
		const scores = last4.map((item) => item.verificationScore);
		if (scores.every((score): score is number => typeof score === "number")) {
			const [first, second, third, fourth] = scores as [number, number, number, number];
			const improvements = [second - first, third - second, fourth - third];
			if (
				improvements.every((value) => value >= 0) &&
				(improvements[0] ?? 0) > 0.01 &&
				improvements.slice(1).every((value) => value < 0.01)
			) {
				return {
					pattern: "diminishing_returns",
					iterations: last4.map((item) => item.iteration),
				};
			}
		}
	}
	return null;
}

function readIterationFingerprintMetadata(value: unknown): {
	phaseId?: string;
	iteration: number;
	outputHash?: string | null;
	diffHash?: string | null;
	failureFingerprint?: string | null;
	verificationScore?: number | null;
	taxonomy?: string[];
} | null {
	const metadata = asRecord(value);
	const fingerprint = asRecord(metadata?.iterationFingerprint);
	if (!fingerprint || typeof fingerprint.iteration !== "number") {
		return null;
	}
	return {
		...(typeof fingerprint.phaseId === "string" ? { phaseId: fingerprint.phaseId } : {}),
		iteration: fingerprint.iteration,
		...(typeof fingerprint.outputHash === "string" ? { outputHash: fingerprint.outputHash } : {}),
		...(typeof fingerprint.diffHash === "string" ? { diffHash: fingerprint.diffHash } : {}),
		...(typeof fingerprint.failureFingerprint === "string"
			? { failureFingerprint: fingerprint.failureFingerprint }
			: {}),
		...(typeof fingerprint.verificationScore === "number"
			? { verificationScore: fingerprint.verificationScore }
			: {}),
		taxonomy: readStringArray(fingerprint.taxonomy),
	};
}

function repeatedFingerprintSignal(items: readonly IterationFingerprintRecord[]): string | null {
	const signals = items.map((item) => item.diffHash ?? item.outputHash ?? null);
	const first = signals[0];
	return first && signals.every((signal) => signal === first) ? first : null;
}

function primaryFingerprintSignal(item: IterationFingerprintRecord): string | null {
	return item.diffHash ?? item.outputHash ?? item.failureFingerprint ?? null;
}

function latestIteration(items: readonly IterationFingerprintRecord[]): number {
	return Math.max(...items.map((item) => item.iteration));
}

function recoveryForStagnationPattern(pattern: StagnationPattern): string {
	if (pattern === "spinning") {
		return "check test target, spec interpretation, and implementation hash before another iteration";
	}
	if (pattern === "oscillation") {
		return "require boundary or architecture review before continuing";
	}
	if (pattern === "no_drift") {
		return "require research or new evidence before another implementation loop";
	}
	return "reduce scope or split the task before continuing";
}

function requireRunnableContract(input: {
	cwd: string;
	host: HostSkillBundleTarget;
	profile: PavedaProfile;
}): ContractValidationResult {
	const validation = validateContractSource({
		cwd: input.cwd,
		host: input.host,
		profile: input.profile,
		includeProjection: true,
	});
	if (!validation.ok) {
		const failures = validation.checks
			.filter((check) => check.status === "fail")
			.map((check) => check.name)
			.join(", ");
		throw new Error(`Contract validation failed before run: ${failures}`);
	}
	return validation;
}

function requireCleanProjection(input: {
	cwd: string;
	host: HostSkillBundleTarget;
}): ProjectionStatusResult {
	const projectionStatus = checkProjectionStatus({ cwd: input.cwd, host: input.host });
	if (!projectionStatus.ok) {
		throw new Error(
			`Projection drift blocks run for ${input.host}. Run paveda projection status --host ${input.host}.`,
		);
	}
	return projectionStatus;
}

function recordCapabilities(
	store: EventStore,
	runId: string,
	host: HostSkillBundleTarget,
	cwd: string,
	ts: number,
): void {
	for (const capability of loadHostCapabilities({ cwd, host }).capabilities) {
		if (!isHostCapabilityEntry(capability)) {
			continue;
		}
		store.recordCapability({
			runId,
			capabilityId: capability.id,
			support: capability.support,
			confidence: capability.confidence,
			source: capability.source,
			details: capability,
			ts,
		});
	}
}

function requiredGatesForTask(
	manifest: ProfileManifest,
	taskType: PavedaTaskType,
	riskSurfaces: readonly RiskSurface[],
): RequiredGate[] {
	const gates = Array.isArray(manifest.requiredGates) ? manifest.requiredGates : [];
	return gates
		.filter(isRequiredGate)
		.filter((gate) =>
			Array.isArray(gate.requiredForTaskTypes)
				? gate.requiredForTaskTypes.includes(taskType)
				: false,
		)
		.filter((gate) => gateAppliesToRiskSurfaces(gate, riskSurfaces));
}

function gateAppliesToRiskSurfaces(
	gate: RequiredGate,
	riskSurfaces: readonly RiskSurface[],
): boolean {
	const metadata = asRecord(gate.metadata);
	const riskPolicy = asRecord(metadata?.riskPolicy);
	if (!riskPolicy) {
		return true;
	}
	const requiredSurfaces = normalizeRiskSurfaces(riskPolicy.requiredSurfaces);
	const notRequiredSurfaces = normalizeRiskSurfaces(riskPolicy.notRequiredSurfaces);
	if (
		notRequiredSurfaces.length > 0 &&
		riskSurfaces.every((surface) => notRequiredSurfaces.includes(surface))
	) {
		return false;
	}
	return requiredSurfaces.length === 0
		? true
		: riskSurfaces.some((surface) => requiredSurfaces.includes(surface));
}

function classifyRunRiskSurfaces(run: RunRecord): RiskSurface[] {
	const context = asRecord(run.context);
	const explicit = normalizeRiskSurfaces(context?.riskSurfaces);
	if (explicit.length > 0) {
		return uniqueRiskSurfaces(explicit);
	}
	const changedFiles = readStringArray(context?.changedFiles);
	if (changedFiles.length > 0) {
		return classifyChangedFiles(changedFiles);
	}
	const taskType = parseTaskType(readTaskType(run));
	if (taskType === "docs" || taskType === "metadata") {
		return ["docs-only"];
	}
	if (taskType === "ui") {
		return ["ui-only"];
	}
	if (taskType === "api") {
		return ["public-api"];
	}
	if (taskType === "infra") {
		return ["infra"];
	}
	if (taskType === "data") {
		return ["data"];
	}
	return ["mixed"];
}

function classifyChangedFiles(files: readonly string[]): RiskSurface[] {
	const normalized = files.map((file) => file.toLowerCase());
	if (normalized.every(isDocsPath)) {
		return ["docs-only"];
	}
	const surfaces: RiskSurface[] = [];
	if (normalized.some((file) => /(^|[/_-])(auth|login|session|oauth|permission|acl)/.test(file))) {
		surfaces.push("auth");
	}
	if (normalized.some((file) => /(payment|billing|checkout|stripe|invoice)/.test(file))) {
		surfaces.push("payment");
	}
	if (
		normalized.some((file) =>
			/(migration|schema|database|db\/|sql|prisma|drizzle|model)/.test(file),
		)
	) {
		surfaces.push("data");
	}
	if (
		normalized.some((file) =>
			/(\.github\/workflows|dockerfile|compose|terraform|k8s|helm|deploy|infra|ci)/.test(file),
		)
	) {
		surfaces.push("infra");
	}
	if (normalized.some((file) => /(api|route|controller|openapi|swagger)/.test(file))) {
		surfaces.push("public-api");
	}
	if (surfaces.length === 0 && normalized.every(isUiPath)) {
		surfaces.push("ui-only");
	}
	if (surfaces.length === 0) {
		surfaces.push("mixed");
	}
	if (surfaces.length > 1) {
		surfaces.push("mixed");
	}
	return uniqueRiskSurfaces(surfaces);
}

function normalizeRiskSurfaces(value: unknown): RiskSurface[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter(isRiskSurface);
}

function uniqueRiskSurfaces(values: readonly RiskSurface[]): RiskSurface[] {
	return [...new Set(values)];
}

function isRiskSurface(value: unknown): value is RiskSurface {
	return (
		value === "auth" ||
		value === "payment" ||
		value === "data" ||
		value === "infra" ||
		value === "public-api" ||
		value === "ui-only" ||
		value === "docs-only" ||
		value === "mixed"
	);
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function isDocsPath(path: string): boolean {
	return (
		path.endsWith(".md") ||
		path.endsWith(".mdx") ||
		path.endsWith(".txt") ||
		path.startsWith("docs/") ||
		path.startsWith("readme") ||
		path.startsWith("changelog")
	);
}

function isUiPath(path: string): boolean {
	return (
		path.endsWith(".tsx") ||
		path.endsWith(".jsx") ||
		path.endsWith(".css") ||
		path.endsWith(".scss") ||
		path.includes("/components/") ||
		path.includes("/pages/") ||
		path.includes("/app/")
	);
}

function verifyGate(gate: RequiredGate, context: VerifyGateContext): VerifyGateResult {
	const evidenceKind = String(gate.evidenceKind);
	const capability = typeof gate.capability === "string" ? gate.capability : null;

	// Check host capability — block if gate requires a capability that is
	// explicitly listed as unsupported by the host. If we can't load host
	// capabilities, or the capability isn't recognized, we let it through.
	if (capability && context.hostCapabilities.length > 0) {
		const isUnsupported = context.hostCapabilities.some(
			(cap) => cap.id === capability && cap.support === "unsupported",
		);
		if (isUnsupported) {
			const behavior =
				typeof gate.missingCapabilityBehavior === "string"
					? gate.missingCapabilityBehavior
					: "block";
			return {
				id: String(gate.id),
				phase: String(gate.phase),
				evidenceKind,
				status: "block",
				message: `Required capability ${capability} is not supported by host.`,
				evidenceIds: [],
				recovery:
					behavior === "ask_setup_sprint"
						? {
								action: "ask_setup_sprint",
								message: `Host does not support ${capability}. Run a setup sprint to add it.`,
							}
						: buildGateRecovery(gate),
			};
		}
	}

	const matching = context.evidence.filter((item) => item.kind === evidenceKind);
	const passing = matching.filter((item) => item.result === "pass");
	if (passing.length > 0) {
		const releaseDecision = evaluateReleasePassingGate(gate, passing, context);
		if (!releaseDecision.ok) {
			return {
				id: String(gate.id),
				phase: String(gate.phase),
				evidenceKind,
				status: "block",
				message: releaseDecision.message,
				evidenceIds: passing.map((item) => item.id),
				recovery: buildGateRecovery(gate),
			};
		}
		return {
			id: String(gate.id),
			phase: String(gate.phase),
			evidenceKind,
			status: "pass",
			message: `${evidenceKind} evidence passed.`,
			evidenceIds: passing.map((item) => item.id),
			recovery: null,
		};
	}
	const blocking = matching.filter(
		(item) => item.result === "fail" || item.result === "block" || item.result === "inconclusive",
	);
	if (blocking.length > 0) {
		return {
			id: String(gate.id),
			phase: String(gate.phase),
			evidenceKind,
			status: "block",
			message: `${evidenceKind} evidence exists but is not passing.`,
			evidenceIds: blocking.map((item) => item.id),
			recovery: buildGateRecovery(gate),
		};
	}
	const notApplicable = matching.filter((item) => item.result === "not_applicable");
	if (notApplicable.length > 0) {
		const notApplicableDecision = evaluateNotApplicableEvidence(
			gate,
			notApplicable,
			context.taskType,
			context.profilePolicy,
		);
		if (!notApplicableDecision.ok) {
			return {
				id: String(gate.id),
				phase: String(gate.phase),
				evidenceKind,
				status: "block",
				message: notApplicableDecision.message,
				evidenceIds: notApplicable.map((item) => item.id),
				recovery: {
					action: "record_not_applicable",
					message:
						"Record auditable not_applicable evidence with rationale, classifier reason, and approval when the profile requires it.",
				},
			};
		}
		return {
			id: String(gate.id),
			phase: String(gate.phase),
			evidenceKind,
			status: "not_applicable",
			message: notApplicableDecision.message,
			evidenceIds: notApplicable.map((item) => item.id),
			recovery: null,
		};
	}
	return {
		id: String(gate.id),
		phase: String(gate.phase),
		evidenceKind,
		status: "block",
		message: `Missing required ${evidenceKind} pass evidence for ${context.taskType} task.`,
		evidenceIds: matching.map((item) => item.id),
		recovery: buildGateRecovery(gate),
	};
}

function evaluateReleasePassingGate(
	gate: RequiredGate,
	passing: readonly EvidenceRecord[],
	context: VerifyGateContext,
): { ok: boolean; message: string } {
	if (context.profile !== "release") {
		return { ok: true, message: "gate does not require release-specific validation" };
	}
	const gateId = String(gate.id);
	if (gateId === "release-signoff") {
		if (
			passing.some(hasReleaseSignoffEvidence) ||
			context.decisions.some(isReleaseSignoffDecision)
		) {
			return { ok: true, message: "release signoff is present" };
		}
		return {
			ok: false,
			message:
				"release-signoff requires manual_decision pass evidence with releaseSignoff metadata or an approve release.signoff decision.",
		};
	}
	if (gateId === "full-conformance") {
		if (
			passing.some(hasFullConformanceEvidence) ||
			context.hostEvents.some(isConformanceHostEvent)
		) {
			return { ok: true, message: "full conformance evidence is present" };
		}
		return {
			ok: false,
			message:
				"full-conformance requires host_event pass evidence with conformanceOk metadata or a release conformance host event.",
		};
	}
	if (gateId === "immutable-artifact-retention") {
		if (passing.some(hasImmutableRetentionEvidence) && context.artifacts.some(isReleaseArtifact)) {
			return { ok: true, message: "immutable release artifact retention is present" };
		}
		return {
			ok: false,
			message:
				"immutable-artifact-retention requires trace pass evidence and at least one immutable release artifact with acceptable redaction status.",
		};
	}
	if (gateId === "risk-gate") {
		if (passing.some((evidence) => hasRiskReviewEvidence(evidence, context.riskSurfaces))) {
			return { ok: true, message: "release risk review evidence is present" };
		}
		return {
			ok: false,
			message:
				"risk-gate requires risk_review pass evidence with reviewedBy, residualRisk, and riskSurfaces metadata.",
		};
	}
	if (gateId === "security-gate") {
		if (passing.some(hasSecurityScanEvidence)) {
			return { ok: true, message: "release security scan evidence is present" };
		}
		return {
			ok: false,
			message:
				"security-gate requires security_scan pass evidence from a project-declared security command or scanner metadata.",
		};
	}
	return { ok: true, message: "release gate evidence passed" };
}

function evaluateNotApplicableEvidence(
	gate: RequiredGate,
	evidence: readonly EvidenceRecord[],
	taskType: PavedaTaskType,
	profilePolicy: ProfileNotApplicablePolicy,
): { ok: boolean; message: string } {
	if (gate.notApplicablePolicy?.allowed !== true) {
		return {
			ok: false,
			message: `${String(gate.evidenceKind)} does not allow not_applicable evidence.`,
		};
	}
	if (!profilePolicy.allowedTaskTypes.includes(taskType)) {
		return {
			ok: false,
			message: `${String(gate.evidenceKind)} not_applicable is only allowed for ${profilePolicy.allowedTaskTypes.join(", ")} tasks.`,
		};
	}
	if (requiresRationale(gate, profilePolicy) && !evidence.some(hasRationale)) {
		return {
			ok: false,
			message: `${String(gate.evidenceKind)} not_applicable evidence requires rationale.`,
		};
	}
	if (requiresClassifierReason(gate, profilePolicy) && !evidence.some(hasClassifierReason)) {
		return {
			ok: false,
			message: `${String(gate.evidenceKind)} not_applicable evidence requires classifierReason metadata.`,
		};
	}
	if (gate.notApplicablePolicy?.requiresUserApproval === true && !evidence.some(hasUserApproval)) {
		return {
			ok: false,
			message: `${String(gate.evidenceKind)} not_applicable evidence requires userApproval metadata.`,
		};
	}
	return {
		ok: true,
		message: `${String(gate.evidenceKind)} is not applicable for ${taskType} task with auditable rationale.`,
	};
}

function buildGateRecovery(gate: RequiredGate): VerifyGateRecovery {
	if (gate.missingCapabilityBehavior === "ask_setup_sprint") {
		return {
			action: "ask_setup_sprint",
			message:
				"Ask the user whether to add minimum test infrastructure in a separate setup sprint before continuing.",
		};
	}
	if (gate.failureBehavior === "repair_then_block") {
		return {
			action: "repair_then_block",
			message: "Repair the failing evidence path, rerun the gate, and block if it still fails.",
		};
	}
	return {
		action: "record_pass_evidence",
		message: "Record direct pass evidence for this gate.",
	};
}

function summarizeVerificationScore(
	gates: readonly VerifyGateResult[],
	manifest: ProfileManifest,
): VerificationScoreSummary {
	const requiredScoredGates = gates.filter((gate) => gate.status !== "warn");
	const requiredGates = requiredScoredGates.length;
	const passedGates = requiredScoredGates.filter((gate) => gate.status === "pass").length;
	const notApplicableGates = requiredScoredGates.filter(
		(gate) => gate.status === "not_applicable",
	).length;
	const blockedGates = requiredScoredGates.filter((gate) => gate.status === "block").length;
	const value = requiredGates === 0 ? 1 : (passedGates + notApplicableGates) / requiredGates;
	const threshold = readVerificationScoreThreshold(manifest);
	const decision = blockedGates === 0 && value >= threshold ? "pass" : "block";
	return {
		metric: "verification_score",
		value,
		threshold,
		decision,
		requiredGates,
		passedGates,
		notApplicableGates,
		blockedGates,
	};
}

function buildVerificationLadder(
	manifest: ProfileManifest,
	gates: readonly VerifyGateResult[],
	evidence: readonly EvidenceRecord[],
): VerifyLadderStepResult[] {
	const ladder = Array.isArray(manifest.verificationLadder)
		? manifest.verificationLadder.filter((step): step is string => typeof step === "string")
		: [];
	const evidenceKinds = new Set([
		...ladder,
		...gates.map((gate) => gate.evidenceKind),
		...evidence.map((item) => item.kind),
	]);
	return [...evidenceKinds].map((evidenceKind) => {
		const stepGates = gates.filter((gate) => gate.evidenceKind === evidenceKind);
		const stepEvidence = evidence.filter((item) => item.kind === evidenceKind);
		if (stepGates.length === 0) {
			return {
				evidenceKind,
				status: "not_required",
				requiredGateIds: [],
				evidenceIds: stepEvidence.map((item) => item.id),
				message:
					stepEvidence.length > 0 ? "Evidence recorded but not required." : "No required gate.",
			};
		}
		if (stepGates.some((gate) => gate.status === "block")) {
			return {
				evidenceKind,
				status: "block",
				requiredGateIds: stepGates.map((gate) => gate.id),
				evidenceIds: stepGates.flatMap((gate) => gate.evidenceIds),
				message: "One or more required gates are blocked.",
			};
		}
		if (stepGates.some((gate) => gate.status === "warn")) {
			return {
				evidenceKind,
				status: "warn",
				requiredGateIds: stepGates.map((gate) => gate.id),
				evidenceIds: stepGates.flatMap((gate) => gate.evidenceIds),
				message: "One or more non-blocking gates emitted warnings.",
			};
		}
		if (stepGates.every((gate) => gate.status === "not_applicable")) {
			return {
				evidenceKind,
				status: "not_applicable",
				requiredGateIds: stepGates.map((gate) => gate.id),
				evidenceIds: stepGates.flatMap((gate) => gate.evidenceIds),
				message: "Required gates are auditable not_applicable.",
			};
		}
		return {
			evidenceKind,
			status: "pass",
			requiredGateIds: stepGates.map((gate) => gate.id),
			evidenceIds: stepGates.flatMap((gate) => gate.evidenceIds),
			message: "Required gates passed.",
		};
	});
}

function buildVerificationStages(input: {
	run: RunRecord;
	profile: PavedaProfile;
	gates: readonly VerifyGateResult[];
	evidence: readonly EvidenceRecord[];
	policyViolations: readonly PolicyViolationRecord[];
	priorPolicyViolations: readonly PolicyViolationRecord[];
	scores: readonly ScoreRecord[];
	riskSurfaces: readonly RiskSurface[];
	manifest: ProfileManifest;
}): VerificationStageResult[] {
	const stageFacts = (["mechanical", "semantic", "review", "consensus"] as const).map((stage) =>
		buildVerificationStageFacts(stage, input.gates, input.evidence),
	);
	const consensusRequired = consensusRequiredForRun({
		profile: input.profile,
		riskSurfaces: input.riskSurfaces,
		gates: input.gates,
		evidence: input.evidence,
		scores: input.scores,
		priorPolicyViolations: input.priorPolicyViolations,
		manifest: input.manifest,
		stageFacts,
	});
	return (["mechanical", "semantic", "review", "consensus"] as const).map((stage) => {
		const facts = stageFacts.find((item) => item.stage === stage);
		if (!facts) {
			throw new Error(`Missing verification stage facts: ${stage}`);
		}
		const required =
			stage === "consensus" ? consensusRequired.required : facts.stageGates.length > 0;
		const result: EvidenceResult =
			facts.blockingGates.length > 0
				? "block"
				: required || facts.stageGates.length > 0 || facts.stageEvidence.length > 0
					? "pass"
					: "not_applicable";
		const blockingPolicyViolationIds = input.policyViolations
			.filter((violation) =>
				facts.blockingGates.some((gate) => (gate.policyId ?? gate.id) === violation.policyId),
			)
			.map((violation) => violation.id);
		return {
			stage,
			result,
			score: facts.score,
			confidence: facts.confidence,
			required,
			triggeredBy: stage === "consensus" ? consensusRequired.triggeredBy : stageTriggeredBy(stage),
			evidenceIds: uniqueNumbers([
				...facts.stageEvidence.map((item) => item.id),
				...facts.stageGates.flatMap((gate) => gate.evidenceIds),
			]),
			blockingPolicyViolationIds,
			...(result === "block"
				? { nextCommand: stageNextCommand(input.run.runId, stage, facts.blockingGates) }
				: {}),
		};
	});
}

interface VerificationStageFacts {
	stage: VerificationStage;
	stageGates: VerifyGateResult[];
	stageEvidence: EvidenceRecord[];
	blockingGates: VerifyGateResult[];
	score: number;
	confidence: number;
}

function buildVerificationStageFacts(
	stage: VerificationStage,
	gates: readonly VerifyGateResult[],
	evidence: readonly EvidenceRecord[],
): VerificationStageFacts {
	const stageGates = gates.filter((gate) => gateStage(gate.evidenceKind) === stage);
	const stageEvidence = evidence.filter((item) => gateStage(item.kind) === stage);
	const blockingGates = stageGates.filter((gate) => gate.status === "block");
	const passedGates = stageGates.filter((gate) => gate.status === "pass").length;
	const notApplicableGates = stageGates.filter((gate) => gate.status === "not_applicable").length;
	const failedEvidence = stageEvidence.filter(
		(item) => item.result === "fail" || item.result === "block" || item.result === "inconclusive",
	);
	const score =
		stageGates.length === 0
			? failedEvidence.length > 0
				? 0
				: 1
			: (passedGates + notApplicableGates) / stageGates.length;
	return {
		stage,
		stageGates,
		stageEvidence,
		blockingGates,
		score,
		confidence: semanticConfidence(stage, stageEvidence, score),
	};
}

function gateStage(evidenceKind: string): VerificationStage {
	if (
		evidenceKind === "spec_compliance_review" ||
		evidenceKind === "code_quality_review" ||
		evidenceKind === "review_stage"
	) {
		return "review";
	}
	if (
		evidenceKind === "semantic_review" ||
		evidenceKind === "acceptance_review" ||
		evidenceKind === "goal_alignment" ||
		evidenceKind === "drift_review"
	) {
		return "semantic";
	}
	if (
		evidenceKind === "risk_review" ||
		evidenceKind === "security_scan" ||
		evidenceKind === "adversarial_review" ||
		evidenceKind === "release_signoff" ||
		evidenceKind === "manual_decision" ||
		evidenceKind === "conformance" ||
		evidenceKind === "host_event" ||
		evidenceKind === "trace"
	) {
		return "consensus";
	}
	return "mechanical";
}

function consensusRequiredForRun(input: {
	profile: PavedaProfile;
	riskSurfaces: readonly RiskSurface[];
	gates: readonly VerifyGateResult[];
	evidence: readonly EvidenceRecord[];
	scores: readonly ScoreRecord[];
	priorPolicyViolations: readonly PolicyViolationRecord[];
	manifest: ProfileManifest;
	stageFacts: readonly VerificationStageFacts[];
}): { required: boolean; triggeredBy: string[] } {
	const triggeredBy: string[] = [];
	if (input.profile === "release") {
		triggeredBy.push("profile:release");
	}
	for (const surface of input.riskSurfaces) {
		if (
			surface === "auth" ||
			surface === "payment" ||
			surface === "data" ||
			surface === "infra" ||
			surface === "public-api"
		) {
			triggeredBy.push(`risk:${surface}`);
		}
	}
	if (input.riskSurfaces.includes("public-api")) {
		triggeredBy.push("public-api:changed");
	}
	if (
		input.gates.some(
			(gate) =>
				(gate.policyId ?? gate.id) === "workflow.spec-binding.drift" && gate.status === "block",
		)
	) {
		triggeredBy.push("spec-binding:drift");
	}
	const semanticFacts = input.stageFacts.find((facts) => facts.stage === "semantic");
	const hasSemanticEvidence = (semanticFacts?.stageEvidence.length ?? 0) > 0;
	if (semanticFacts && hasSemanticEvidence) {
		const semanticThreshold = readStageThreshold(input.manifest, "semantic");
		if (semanticFacts.score < semanticThreshold) {
			triggeredBy.push("semantic:score-below-threshold");
		}
		if (semanticFacts.confidence < readSemanticConfidenceThreshold(input.manifest)) {
			triggeredBy.push("semantic:low-confidence");
		}
	}
	if (
		hasRepeatedDistinctVerificationFailures(
			input.scores,
			input.priorPolicyViolations,
			input.evidence,
		)
	) {
		triggeredBy.push("verification:repeated-distinct-failures");
	}
	return {
		required: triggeredBy.length > 0,
		triggeredBy: uniqueStrings(triggeredBy),
	};
}

function semanticConfidence(
	stage: VerificationStage,
	evidence: readonly EvidenceRecord[],
	score: number,
): number {
	if (stage !== "semantic") {
		return score;
	}
	const confidenceValues = evidence
		.map((item) => readNumberFromMetadata(item.metadata, "confidence"))
		.filter((value): value is number => typeof value === "number");
	if (confidenceValues.length === 0) {
		return score;
	}
	return Math.min(...confidenceValues);
}

function readStageThreshold(manifest: ProfileManifest, stage: VerificationStage): number {
	const stages = Array.isArray(manifest.verificationStages) ? manifest.verificationStages : [];
	const match = stages.map(asRecord).find((candidate) => {
		return candidate?.stage === stage && typeof candidate.threshold === "number";
	});
	return typeof match?.threshold === "number"
		? match.threshold
		: readVerificationScoreThreshold(manifest);
}

function readSemanticConfidenceThreshold(manifest: ProfileManifest): number {
	return Math.min(readStageThreshold(manifest, "semantic"), 0.7);
}

function hasRepeatedDistinctVerificationFailures(
	scores: readonly ScoreRecord[],
	policyViolations: readonly PolicyViolationRecord[],
	evidence: readonly EvidenceRecord[],
): boolean {
	const failedVerifications = scores.filter(
		(score) => score.metric === "verification_score" && score.decision === "block",
	);
	if (failedVerifications.length < 2) {
		return false;
	}
	const failureClasses = new Set<string>();
	for (const violation of policyViolations.filter((violation) => violation.blocked)) {
		failureClasses.add(violation.policyId);
	}
	for (const item of evidence.filter(
		(item) => item.result === "fail" || item.result === "block" || item.result === "inconclusive",
	)) {
		failureClasses.add(item.kind);
	}
	return failureClasses.size >= 2;
}

function stageTriggeredBy(stage: VerificationStage): string[] {
	if (stage === "mechanical") return ["verification:deterministic"];
	if (stage === "review") return ["verification:two-stage-review"];
	return ["verification:semantic"];
}

function stageNextCommand(
	runId: string,
	stage: VerificationStage,
	blockingGates: readonly VerifyGateResult[],
): string {
	const firstGate = blockingGates[0];
	if (!firstGate) {
		return `paveda verify --run ${runId} --stage ${stage}`;
	}
	return [
		"paveda evidence add",
		`--run ${runId}`,
		`--phase ${firstGate.phase}`,
		`--kind ${firstGate.evidenceKind}`,
		"--result pass",
		'--rationale "record passing evidence"',
	].join(" ");
}

function uniqueNumbers(values: readonly number[]): number[] {
	return [...new Set(values)];
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function readNumberFromMetadata(metadata: unknown, key: string): number | null {
	const record = asRecord(metadata);
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRequiredGate(value: unknown): value is RequiredGate {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as RequiredGate).id === "string" &&
		typeof (value as RequiredGate).phase === "string" &&
		typeof (value as RequiredGate).evidenceKind === "string" &&
		Array.isArray((value as RequiredGate).requiredForTaskTypes)
	);
}

function readProfileNotApplicablePolicy(manifest: ProfileManifest): ProfileNotApplicablePolicy {
	const policy = manifest.notApplicablePolicy;
	return {
		allowedTaskTypes: Array.isArray(policy?.allowedTaskTypes)
			? policy.allowedTaskTypes.filter((item): item is string => typeof item === "string")
			: [],
		requiresRationale: policy?.requiresRationale === true,
		requiresClassifierReason: policy?.requiresClassifierReason === true,
	};
}

function readVerificationScoreThreshold(manifest: ProfileManifest): number {
	const thresholds = Array.isArray(manifest.scoreThresholds) ? manifest.scoreThresholds : [];
	const threshold = thresholds
		.filter(isScoreThreshold)
		.find((item) => item.metric === "verification_score");
	return typeof threshold?.pass === "number" ? threshold.pass : 1;
}

function isScoreThreshold(value: unknown): value is ScoreThreshold {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ScoreThreshold).metric === "string"
	);
}

function requiresRationale(gate: RequiredGate, profilePolicy: ProfileNotApplicablePolicy): boolean {
	return gate.notApplicablePolicy?.requiresRationale === true || profilePolicy.requiresRationale;
}

function requiresClassifierReason(
	gate: RequiredGate,
	profilePolicy: ProfileNotApplicablePolicy,
): boolean {
	return (
		gate.notApplicablePolicy?.requiresClassifierReason === true ||
		profilePolicy.requiresClassifierReason
	);
}

function hasRationale(evidence: EvidenceRecord): boolean {
	return typeof evidence.rationale === "string" && evidence.rationale.trim().length > 0;
}

function hasClassifierReason(evidence: EvidenceRecord): boolean {
	const metadata = evidence.metadata;
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		typeof (metadata as { classifierReason?: unknown }).classifierReason === "string" &&
		(metadata as { classifierReason: string }).classifierReason.trim().length > 0
	);
}

function hasUserApproval(evidence: EvidenceRecord): boolean {
	const metadata = evidence.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return false;
	}
	const approval = (metadata as { userApproval?: unknown; approvedBy?: unknown }).userApproval;
	const approvedBy = (metadata as { approvedBy?: unknown }).approvedBy;
	return approval === true || (typeof approvedBy === "string" && approvedBy.trim().length > 0);
}

function hasReleaseSignoffEvidence(evidence: EvidenceRecord): boolean {
	const metadata = asRecord(evidence.metadata);
	if (!metadata) {
		return false;
	}
	const signoff = metadata.releaseSignoff;
	const approvedBy = metadata.approvedBy;
	return signoff === true && typeof approvedBy === "string" && approvedBy.trim().length > 0;
}

function isReleaseSignoffDecision(decision: DecisionRecord): boolean {
	return (
		decision.decisionType === "release.signoff" &&
		decision.decision === "approve" &&
		decision.override === false
	);
}

function hasFullConformanceEvidence(evidence: EvidenceRecord): boolean {
	const metadata = asRecord(evidence.metadata);
	if (!metadata || metadata.conformanceOk !== true) {
		return false;
	}
	return Array.isArray(metadata.fixturesPassed) && metadata.fixturesPassed.length > 0;
}

function hasRiskReviewEvidence(
	evidence: EvidenceRecord,
	riskSurfaces: readonly RiskSurface[],
): boolean {
	const metadata = asRecord(evidence.metadata);
	if (!metadata) {
		return false;
	}
	const reviewedBy = metadata.reviewedBy;
	const residualRisk = metadata.residualRisk;
	const evidenceSurfaces = normalizeRiskSurfaces(metadata.riskSurfaces);
	return (
		typeof reviewedBy === "string" &&
		reviewedBy.trim().length > 0 &&
		(residualRisk === "low" || residualRisk === "medium" || residualRisk === "high") &&
		evidenceSurfaces.length > 0 &&
		riskSurfaces.every((surface) => surface === "mixed" || evidenceSurfaces.includes(surface))
	);
}

function hasSecurityScanEvidence(evidence: EvidenceRecord): boolean {
	const metadata = asRecord(evidence.metadata);
	const scanner = metadata?.scanner;
	return (
		(typeof evidence.command === "string" && evidence.command.trim().length > 0) ||
		(typeof scanner === "string" && scanner.trim().length > 0)
	);
}

function isConformanceHostEvent(event: HostEventRecord): boolean {
	const payload = asRecord(event.payload);
	return (
		event.eventType === "release.conformance.completed" &&
		event.normalizedStatus === "completed" &&
		payload?.conformanceOk === true
	);
}

function hasImmutableRetentionEvidence(evidence: EvidenceRecord): boolean {
	const metadata = asRecord(evidence.metadata);
	return metadata?.artifactRetention === "immutable" || metadata?.releaseRetention === "immutable";
}

function isReleaseArtifact(artifact: ArtifactRecord): boolean {
	if (artifact.redactionStatus === "failed" || artifact.redactionStatus === "pending") {
		return false;
	}
	const metadata = asRecord(artifact.metadata);
	const retention = asRecord(metadata?.releaseRetention);
	return (
		retention?.policy === "release" &&
		retention?.mode === "immutable" &&
		retention?.immutable === true &&
		typeof artifact.sha256 === "string" &&
		artifact.sha256.length === 64
	);
}

function evidenceMatchesTask(evidence: EvidenceRecord, task: string): boolean {
	const metadata = asRecord(evidence.metadata);
	return (
		metadata?.task === task ||
		metadata?.taskId === task ||
		metadata?.task_id === task ||
		evidence.evidenceId === task ||
		evidence.evidenceId.startsWith(`${task}:`)
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function specBindingGate(input: {
	policyId: string;
	status: "pass" | "warn" | "block";
	message: string;
	recovery: string | null;
}): VerifyGateResult {
	return {
		id: "spec-binding-gate",
		policyId: input.policyId,
		phase: "intake",
		evidenceKind: "spec_binding",
		status: input.status,
		message: input.message,
		evidenceIds: [],
		recovery: input.recovery
			? {
					action: "repair_then_block",
					message: input.recovery,
				}
			: null,
	};
}

function isCodeChangingTask(taskType: PavedaTaskType): boolean {
	return (
		taskType === "code" ||
		taskType === "ui" ||
		taskType === "api" ||
		taskType === "data" ||
		taskType === "infra" ||
		taskType === "test" ||
		taskType === "mixed"
	);
}

function ambiguityThresholdForProfile(profile: PavedaProfile): number | null {
	if (profile === "release") {
		return 0.25;
	}
	if (profile === "strict") {
		return 0.35;
	}
	if (profile === "standard") {
		return 0.5;
	}
	return null;
}

export function ontologyBoostedAmbiguityThreshold(
	store: EventStore,
	runId: string,
	baseThreshold: number,
): number {
	const convergences = store
		.replay(runId)
		.filter((event) => event.type === "spec.ontology.convergence");
	if (convergences.length === 0) {
		return baseThreshold;
	}
	const latestEvent = convergences[convergences.length - 1];
	const status = latestEvent && (latestEvent.payload as Record<string, unknown>)?.status;
	if (status === "converged") {
		return baseThreshold * 2;
	}
	if (status === "stagnating") {
		return baseThreshold * 1.3;
	}
	return baseThreshold;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			return item;
		}
		return Object.fromEntries(
			Object.entries(item as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right)),
		);
	});
}

function isSpecBindingSourceType(value: unknown): value is RunSpecBindingSourceType {
	return (
		value === "inline" ||
		value === "spec_file" ||
		value === "contract_source" ||
		value === "host_goal"
	);
}

function isPavedaProfile(value: unknown): value is PavedaProfile {
	return value === "fast" || value === "standard" || value === "strict" || value === "release";
}

function isHostCapabilityEntry(value: unknown): value is HostCapabilityEntry {
	const candidate = value as Partial<HostCapabilityEntry>;
	return (
		typeof candidate?.id === "string" &&
		typeof candidate.support === "string" &&
		typeof candidate.confidence === "number" &&
		typeof candidate.source === "string"
	);
}

function parseEvidenceResult(value: string): EvidenceResult {
	if (
		value === "pass" ||
		value === "fail" ||
		value === "block" ||
		value === "not_applicable" ||
		value === "inconclusive"
	) {
		return value;
	}
	throw new Error(`Invalid evidence result: ${value}`);
}

function parseOptionalVerificationStage(value: string | undefined): VerificationStage | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		value === "mechanical" ||
		value === "semantic" ||
		value === "consensus" ||
		value === "review"
	) {
		return value;
	}
	throw new Error(`Invalid verification stage: ${value}`);
}

function readTaskType(run: RunRecord): string {
	const context = run.context;
	if (context && typeof context === "object" && "taskType" in context) {
		const taskType = (context as { taskType?: unknown }).taskType;
		return typeof taskType === "string" ? taskType : DEFAULT_TASK_TYPE;
	}
	return DEFAULT_TASK_TYPE;
}

function parseTaskType(value: string): PavedaTaskType {
	if (
		value === "code" ||
		value === "ui" ||
		value === "api" ||
		value === "data" ||
		value === "infra" ||
		value === "test" ||
		value === "docs" ||
		value === "metadata" ||
		value === "mixed" ||
		value === "command"
	) {
		return value;
	}
	throw new Error(`Invalid Paveda task type: ${value}`);
}

function normalizeExitCode(status: number | null, error: Error | undefined): number {
	if (typeof status === "number") {
		return status;
	}
	return error ? 1 : 0;
}

function isScoreRecord(value: unknown): value is ScoreRecord {
	return typeof value === "object" && value !== null && "id" in value;
}

function asScoreMetricDefinition(value: unknown): ScoreMetricDefinition | null {
	if (typeof value !== "object" || value === null) return null;
	const def = value as Record<string, unknown>;
	if (typeof def.id !== "string") return null;
	if (typeof def.direction !== "string") return null;
	if (
		!def.range ||
		typeof (def.range as Record<string, unknown>).min !== "number" ||
		typeof (def.range as Record<string, unknown>).max !== "number"
	)
		return null;
	if (!def.calculation || typeof (def.calculation as Record<string, unknown>).kind !== "string")
		return null;
	const kind = (def.calculation as Record<string, unknown>).kind as string;
	if (
		kind !== "evidence_ratio" &&
		kind !== "threshold_check" &&
		kind !== "weighted_inputs" &&
		kind !== "risk_rule" &&
		kind !== "manual_review" &&
		kind !== "direct_gate_result"
	)
		return null;
	return def as unknown as ScoreMetricDefinition;
}

function asScoreThreshold(value: unknown): ScoreThreshold | null {
	if (typeof value !== "object" || value === null) return null;
	const t = value as Record<string, unknown>;
	if (typeof t.metric !== "string") return null;
	if (typeof t.pass !== "number") return null;
	if (typeof t.block !== "number") return null;
	return {
		metric: t.metric,
		pass: t.pass,
		...(typeof t.warn === "number" ? { warn: t.warn } : {}),
		block: t.block,
		...(typeof t.repairTrigger === "number" ? { repairTrigger: t.repairTrigger } : {}),
		...(typeof t.overrideAllowed === "boolean" ? { overrideAllowed: t.overrideAllowed } : {}),
	};
}

function readChangedFileCount(run: RunRecord): number {
	const metadata = asRecord(run.metadata);
	if (!metadata) return 0;
	const changedFiles = metadata.changedFiles;
	if (Array.isArray(changedFiles)) return changedFiles.length;
	if (typeof changedFiles === "number") return changedFiles;
	return 0;
}
