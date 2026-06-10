import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { type CodexGoalHandoff, buildCodexGoalHandoff } from "../adapters/codex/index.js";
import {
	type ContractValidationResult,
	assertMvpExecutableProfile,
	loadHostCapabilities,
	loadProfileManifest,
	parsePavedaProfileValue,
	validateContractSource,
} from "../contract/index.js";
import type { HostSkillBundleTarget } from "../host-bundles/index.js";
import { parseHostSkillBundleTarget } from "../host-bundles/index.js";
import { type ProjectionStatusResult, checkProjectionStatus } from "../projection/index.js";
import {
	type ArtifactRecord,
	type DecisionRecord,
	EventStore,
	type EvidenceRecord,
	type EvidenceResult,
	type HostEventRecord,
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

export interface StartPavedaDoOptions {
	cwd?: string;
	host?: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	objective: string;
	taskType?: PavedaTaskType | string;
	acceptanceCriteria?: string[];
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
	| CodexGoalHandoff;

export interface RunHostCommandOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	objective?: string;
	taskType?: PavedaTaskType | string;
	acceptanceCriteria?: string[];
	nativeArgs: string[];
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
	policyViolations: PolicyViolationRecord[];
}

export interface VerifyRunOptions {
	cwd?: string;
	runId: string;
	profile?: PavedaProfile | string;
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
	ladder: VerifyLadderStepResult[];
	scoreSummary: VerificationScoreSummary;
	score: ScoreRecord | null;
	policyViolations: PolicyViolationRecord[];
}

export interface VerifyGateResult {
	id: string;
	phase: string;
	evidenceKind: string;
	status: "pass" | "block" | "not_applicable";
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
	status: "pass" | "block" | "not_applicable" | "not_required";
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
	missingCapabilityBehavior?: unknown;
	failureBehavior?: unknown;
	notApplicablePolicy?: {
		allowed?: unknown;
		requiresRationale?: unknown;
		requiresClassifierReason?: unknown;
		requiresUserApproval?: unknown;
	};
}

interface ProfileManifest {
	requiredGates?: unknown[];
	scoreThresholds?: unknown[];
	verificationLadder?: unknown[];
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

interface ScoreThreshold {
	metric?: unknown;
	pass?: unknown;
}

interface HostCapabilityEntry {
	id: string;
	support: string;
	confidence: number;
	source: string;
}

const DEFAULT_HOST: HostSkillBundleTarget = "codex";
const DEFAULT_TASK_TYPE: PavedaTaskType = "code";
const SUCCESS_EXIT_CODE = 0;

export function startPavedaDo(options: StartPavedaDoOptions): StartPavedaDoResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = options.host ? parseHostSkillBundleTarget(options.host) : DEFAULT_HOST;
	const profile = parsePavedaProfileValue(options.profile);
	assertMvpExecutableProfile(profile);
	const taskType = parseTaskType(options.taskType ?? DEFAULT_TASK_TYPE);
	const validation = requireRunnableContract({ cwd, host, profile });
	const projectionStatus = requireCleanProjection({ cwd, host });
	const now = options.now ?? Date.now();
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);

	try {
		const hostNativePrimitive = host === "codex" ? "goal" : "pending_adapter";
		const run = store.createRun({
			objective: options.objective,
			acceptanceCriteria: options.acceptanceCriteria ?? [],
			profile,
			host,
			context: {
				taskType,
				entrypoint: "paveda do",
				hostNativePrimitive,
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

export function runHostCommand(options: RunHostCommandOptions): RunHostCommandResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfileValue(options.profile);
	assertMvpExecutableProfile(profile);
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
		const run = store.createRun({
			objective: options.objective ?? options.nativeArgs.join(" "),
			acceptanceCriteria: options.acceptanceCriteria ?? [],
			profile,
			host,
			context: {
				taskType,
				entrypoint: "paveda run",
				command: options.nativeArgs,
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
		const stdoutArtifact =
			stdout.length > 0
				? store.writeArtifact({
						runId: run.runId,
						kind: "command-stdout",
						fileName: "stdout.txt",
						content: stdout,
						metadata: { command: options.nativeArgs },
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
						metadata: { command: options.nativeArgs },
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
		return store.recordEvidence({
			runId: options.runId,
			phaseId: options.phaseId ?? null,
			evidenceId: options.evidenceId,
			kind: options.kind,
			result: parseEvidenceResult(options.result),
			command: options.command ?? null,
			exitCode: options.exitCode ?? null,
			rationale: options.rationale ?? null,
			metadata: options.metadata,
			ts: options.now ?? Date.now(),
		});
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
		return {
			run,
			phaseEvents: store.listPhaseEvents(options.runId),
			evidence: store.listEvidence(options.runId),
			artifacts: store.listArtifacts(options.runId),
			hostEvents: store.listHostEvents(options.runId),
			scores: store.listScores(options.runId),
			decisions: store.listDecisions(options.runId),
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
	assertMvpExecutableProfile(profile);
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const run = store.getRun(options.runId);
		if (!run) {
			throw new Error(`Run does not exist: ${options.runId}`);
		}
		const taskType = parseTaskType(readTaskType(run));
		const evidence = store.listEvidence(run.runId);
		const manifest = loadProfileManifest(cwd, profile);
		const profilePolicy = readProfileNotApplicablePolicy(manifest);
		const gates = requiredGatesForTask(manifest, taskType).map((gate) =>
			verifyGate(gate, evidence, taskType, profilePolicy),
		);
		const scoreSummary = summarizeVerificationScore(gates, manifest);
		const ladder = buildVerificationLadder(manifest, gates, evidence);
		const ok =
			scoreSummary.decision === "pass" &&
			gates.every((gate) => gate.status === "pass" || gate.status === "not_applicable");
		const now = options.now ?? Date.now();
		const policyViolations = options.write
			? gates
					.filter((gate) => gate.status === "block")
					.map((gate) =>
						store.recordPolicyViolation({
							runId: run.runId,
							policyId: gate.id,
							severity: "error",
							message: gate.message,
							blocked: true,
							ts: now,
						}),
					)
			: [];
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
			ladder,
			scoreSummary,
			score,
			policyViolations,
		};
	} finally {
		store.close();
	}
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

function requiredGatesForTask(manifest: ProfileManifest, taskType: PavedaTaskType): RequiredGate[] {
	const gates = Array.isArray(manifest.requiredGates) ? manifest.requiredGates : [];
	return gates
		.filter(isRequiredGate)
		.filter((gate) =>
			Array.isArray(gate.requiredForTaskTypes)
				? gate.requiredForTaskTypes.includes(taskType)
				: false,
		);
}

function verifyGate(
	gate: RequiredGate,
	evidence: readonly EvidenceRecord[],
	taskType: PavedaTaskType,
	profilePolicy: ProfileNotApplicablePolicy,
): VerifyGateResult {
	const evidenceKind = String(gate.evidenceKind);
	const matching = evidence.filter((item) => item.kind === evidenceKind);
	const passing = matching.filter((item) => item.result === "pass");
	if (passing.length > 0) {
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
			taskType,
			profilePolicy,
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
		message: `Missing required ${evidenceKind} pass evidence for ${taskType} task.`,
		evidenceIds: matching.map((item) => item.id),
		recovery: buildGateRecovery(gate),
	};
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
	const requiredGates = gates.length;
	const passedGates = gates.filter((gate) => gate.status === "pass").length;
	const notApplicableGates = gates.filter((gate) => gate.status === "not_applicable").length;
	const blockedGates = gates.filter((gate) => gate.status === "block").length;
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
