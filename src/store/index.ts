import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";
import type {
	EnforcementTier,
	PolicyDecisionAction,
	PolicySeverity as RuntimePolicySeverity,
} from "../policy/index.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const CURRENT_SCHEMA_VERSION = 3;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_STORE_OPEN_RETRIES = 8;
export const DEFAULT_STORE_OPEN_RETRY_DELAY_MS = 100;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionStatus = "active" | "completed" | "failed" | "compacted";

export type RouterTier = "frugal" | "standard" | "frontier";

export type RouterDecisionResult = "success" | "retry" | "abort";

export type RoutedSkill = "do";

export type InstinctScope = "project" | "user";

export type InstinctStatus = "pending" | "active" | "promoted" | "expired";

export type StoreScope = "project" | "user";

export type RunStatus = "active" | "completed" | "failed" | "blocked";

export type PavedaProfile = "fast" | "standard" | "strict" | "release";

export type PhaseStatus =
	| "pending"
	| "active"
	| "completed"
	| "failed"
	| "blocked"
	| "not_applicable";

export type EvidenceResult = "pass" | "fail" | "block" | "not_applicable" | "inconclusive";

export type ArtifactRedactionStatus = "not_required" | "pending" | "redacted" | "failed";

export type LearningState = "observed" | "candidate" | "validated" | "promoted" | "retired";

export type PolicySeverity = "info" | "warning" | "error" | "block";

export interface EventRecord {
	id: number;
	sessionId: string;
	ts: number;
	type: string;
	payload: unknown;
}

export interface AppendEventInput {
	sessionId: string;
	type: string;
	payload?: unknown;
	ts?: number;
}

export interface SessionSummary {
	id: string;
	startedAt: number;
	endedAt: number | null;
	costUsd: number;
	agentSpawns: number;
	toolCalls: number;
	status: SessionStatus;
}

export interface RouterDecision {
	id: number;
	sessionId: string;
	ts: number;
	skill: RoutedSkill;
	tier: RouterTier;
	reason: string | null;
	result: RouterDecisionResult | null;
}

export interface InstinctRecord {
	id: number;
	scope: InstinctScope;
	pattern: string;
	evidence: string | null;
	examples: unknown;
	confidence: number;
	ttlExpiresAt: number | null;
	status: InstinctStatus;
}

export interface PolicyDecisionRecord {
	id: number;
	sessionId: string;
	ts: number;
	eventId: number | null;
	host: string;
	ruleId: string;
	action: PolicyDecisionAction;
	severity: RuntimePolicySeverity;
	tier: EnforcementTier;
	reason: string | null;
	enforced: boolean;
	evidence: unknown;
}

export interface AppendRouterDecisionInput {
	sessionId: string;
	skill?: RoutedSkill;
	tier: RouterTier;
	reason?: string | null;
	result?: RouterDecisionResult | null;
	ts?: number;
}

export interface AppendInstinctInput {
	scope: InstinctScope;
	pattern: string;
	evidence?: string | null;
	examples?: unknown;
	confidence: number;
	ttlExpiresAt?: number | null;
	status?: InstinctStatus;
}

export interface AppendPolicyDecisionInput {
	sessionId: string;
	ts?: number;
	eventId?: number | null;
	host: string;
	ruleId: string;
	action: PolicyDecisionAction;
	severity: RuntimePolicySeverity;
	tier: EnforcementTier;
	reason?: string | null;
	enforced: boolean;
	evidence?: unknown;
}

export interface ReplayOptions {
	since?: number;
}

export interface ListSessionsOptions {
	status?: SessionStatus;
	since?: number;
}

export interface RouterLineageOptions {
	since?: number;
}

export interface ListRouterDecisionsOptions {
	skill?: RoutedSkill;
	since?: number;
	limit?: number;
}

export interface ListInstinctsOptions {
	scope?: InstinctScope;
	status?: InstinctStatus;
	includeExpired?: boolean;
	now?: number;
	limit?: number;
}

export interface ListPolicyDecisionsOptions {
	sessionId?: string;
	host?: string;
	ruleId?: string;
	action?: PolicyDecisionAction;
	since?: number;
	limit?: number;
}

export interface ListLearningPatternsOptions {
	runId?: string;
	scope?: InstinctScope | "shared";
	state?: LearningState;
	limit?: number;
}

export interface CreateRunInput {
	runId?: string;
	objective: string;
	acceptanceCriteria?: unknown;
	profile?: PavedaProfile;
	host?: string | null;
	context?: unknown;
	metadata?: unknown;
	ts?: number;
}

export interface RunRecord {
	runId: string;
	objective: string;
	acceptanceCriteria: unknown;
	profile: PavedaProfile;
	host: string | null;
	status: RunStatus;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	context: unknown;
	metadata: unknown;
}

export interface UpsertPhaseInput {
	runId: string;
	phaseId: string;
	status?: PhaseStatus;
	startedAt?: number | null;
	endedAt?: number | null;
	hostMapping?: unknown;
	metadata?: unknown;
}

export interface PhaseRecord {
	id: number;
	runId: string;
	phaseId: string;
	status: PhaseStatus;
	startedAt: number | null;
	endedAt: number | null;
	hostMapping: unknown;
	metadata: unknown;
}

export interface AppendPhaseEventInput {
	runId: string;
	phaseId: string;
	eventType: string;
	status?: PhaseStatus | null;
	payload?: unknown;
	ts?: number;
}

export interface PhaseEventRecord {
	id: number;
	runId: string;
	phaseId: string;
	ts: number;
	eventType: string;
	status: PhaseStatus | null;
	payload: unknown;
}

export interface RecordScoreInput {
	runId: string;
	metric: string;
	value: number;
	decision: "pass" | "warn" | "repair" | "block";
	threshold?: number | null;
	rationale?: string | null;
	ts?: number;
}

export interface ScoreRecord {
	id: number;
	runId: string;
	metric: string;
	value: number;
	decision: "pass" | "warn" | "repair" | "block";
	threshold: number | null;
	rationale: string | null;
	ts: number;
}

export interface RecordArtifactInput {
	runId: string;
	kind: string;
	relativePath: string;
	sha256: string;
	byteLength: number;
	redactionStatus: ArtifactRedactionStatus;
	metadata?: unknown;
	createdAt?: number;
}

export interface ArtifactRecord {
	id: number;
	runId: string;
	kind: string;
	relativePath: string;
	sha256: string;
	byteLength: number;
	redactionStatus: ArtifactRedactionStatus;
	metadata: unknown;
	createdAt: number;
}

export interface WriteArtifactInput {
	runId: string;
	kind: string;
	fileName: string;
	content: string | Uint8Array;
	redactionStatus?: ArtifactRedactionStatus;
	metadata?: unknown;
	createdAt?: number;
}

export interface RecordEvidenceInput {
	runId: string;
	phaseId?: string | null;
	evidenceId: string;
	kind: string;
	result: EvidenceResult;
	command?: string | null;
	exitCode?: number | null;
	rationale?: string | null;
	artifactId?: number | null;
	metadata?: unknown;
	ts?: number;
}

export interface EvidenceRecord {
	id: number;
	runId: string;
	phaseId: string | null;
	evidenceId: string;
	kind: string;
	result: EvidenceResult;
	command: string | null;
	exitCode: number | null;
	rationale: string | null;
	artifactId: number | null;
	metadata: unknown;
	ts: number;
}

export interface RecordCapabilityInput {
	runId: string;
	capabilityId: string;
	support: string;
	confidence: number;
	source: string;
	details?: unknown;
	ts?: number;
}

export interface CapabilityRecord {
	id: number;
	runId: string;
	capabilityId: string;
	support: string;
	confidence: number;
	source: string;
	details: unknown;
	ts: number;
}

export interface AppendHostEventInput {
	runId: string;
	host: string;
	eventType: string;
	normalizedStatus?: string | null;
	payload?: unknown;
	ts?: number;
}

export interface HostEventRecord {
	id: number;
	runId: string;
	host: string;
	eventType: string;
	normalizedStatus: string | null;
	payload: unknown;
	ts: number;
}

export interface RecordDecisionInput {
	runId: string;
	phaseId?: string | null;
	decisionType: string;
	decision: string;
	rationale: string;
	override?: boolean;
	expiresAt?: number | null;
	ts?: number;
}

export interface DecisionRecord {
	id: number;
	runId: string;
	phaseId: string | null;
	decisionType: string;
	decision: string;
	rationale: string;
	override: boolean;
	expiresAt: number | null;
	ts: number;
}

export interface RecordLearningPatternInput {
	runId: string;
	scope: InstinctScope | "shared";
	state: LearningState;
	pattern: string;
	confidence: number;
	evidenceId?: number | null;
	metadata?: unknown;
	ts?: number;
}

export interface UpdateLearningPatternStateInput {
	id: number;
	state: LearningState;
	metadata?: unknown;
	ts?: number;
}

export interface LearningPatternRecord {
	id: number;
	runId: string;
	scope: InstinctScope | "shared";
	state: LearningState;
	pattern: string;
	confidence: number;
	evidenceId: number | null;
	promotedAt: number | null;
	retiredAt: number | null;
	metadata: unknown;
	ts: number;
}

export interface RecordPolicyViolationInput {
	runId: string;
	policyId: string;
	severity: PolicySeverity;
	message: string;
	blocked: boolean;
	evidenceId?: number | null;
	ts?: number;
}

export interface PolicyViolationRecord {
	id: number;
	runId: string;
	policyId: string;
	severity: PolicySeverity;
	message: string;
	blocked: boolean;
	evidenceId: number | null;
	ts: number;
}

type EventRow = {
	id: number;
	session_id: string;
	ts: number;
	type: string;
	payload: string;
};

type SessionRow = {
	id: string;
	started_at: number;
	ended_at: number | null;
	cost_usd: number;
	agent_spawns: number;
	tool_calls: number;
	status: SessionStatus;
};

type RouterDecisionRow = {
	id: number;
	session_id: string;
	ts: number;
	skill: RoutedSkill;
	tier: RouterTier;
	reason: string | null;
	result: RouterDecisionResult | null;
};

type InstinctRow = {
	id: number;
	scope: InstinctScope;
	pattern: string;
	evidence: string | null;
	examples: string | null;
	confidence: number;
	ttl_expires_at: number | null;
	status: InstinctStatus;
};

type PolicyDecisionRow = {
	id: number;
	session_id: string;
	ts: number;
	event_id: number | null;
	host: string;
	rule_id: string;
	action: PolicyDecisionAction;
	severity: RuntimePolicySeverity;
	tier: EnforcementTier;
	reason: string | null;
	enforced: number;
	evidence: string;
};

type RunRow = {
	run_id: string;
	objective: string;
	acceptance_criteria: string;
	profile: PavedaProfile;
	host: string | null;
	status: RunStatus;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	context: string | null;
	metadata: string | null;
};

type PhaseRow = {
	id: number;
	run_id: string;
	phase_id: string;
	status: PhaseStatus;
	started_at: number | null;
	ended_at: number | null;
	host_mapping: string | null;
	metadata: string | null;
};

type PhaseEventRow = {
	id: number;
	run_id: string;
	phase_id: string;
	ts: number;
	event_type: string;
	status: PhaseStatus | null;
	payload: string | null;
};

type ScoreRow = {
	id: number;
	run_id: string;
	metric: string;
	value: number;
	decision: "pass" | "warn" | "repair" | "block";
	threshold: number | null;
	rationale: string | null;
	ts: number;
};

type ArtifactRow = {
	id: number;
	run_id: string;
	kind: string;
	relative_path: string;
	sha256: string;
	byte_length: number;
	redaction_status: ArtifactRedactionStatus;
	metadata: string | null;
	created_at: number;
};

type EvidenceRow = {
	id: number;
	run_id: string;
	phase_id: string | null;
	evidence_id: string;
	kind: string;
	result: EvidenceResult;
	command: string | null;
	exit_code: number | null;
	rationale: string | null;
	artifact_id: number | null;
	metadata: string | null;
	ts: number;
};

type CapabilityRow = {
	id: number;
	run_id: string;
	capability_id: string;
	support: string;
	confidence: number;
	source: string;
	details: string | null;
	ts: number;
};

type HostEventRow = {
	id: number;
	run_id: string;
	host: string;
	event_type: string;
	normalized_status: string | null;
	payload: string | null;
	ts: number;
};

type DecisionRow = {
	id: number;
	run_id: string;
	phase_id: string | null;
	decision_type: string;
	decision: string;
	rationale: string;
	override: number;
	expires_at: number | null;
	ts: number;
};

type LearningPatternRow = {
	id: number;
	run_id: string;
	scope: InstinctScope | "shared";
	state: LearningState;
	pattern: string;
	confidence: number;
	evidence_id: number | null;
	promoted_at: number | null;
	retired_at: number | null;
	metadata: string | null;
	ts: number;
};

type PolicyViolationRow = {
	id: number;
	run_id: string;
	policy_id: string;
	severity: PolicySeverity;
	message: string;
	blocked: number;
	evidence_id: number | null;
	ts: number;
};

type SchemaMigrationRow = {
	version: number;
};

interface StoreMigration {
	version: number;
	name: string;
	sql: string;
}

const STORE_MIGRATIONS: readonly StoreMigration[] = [
	{
		version: 1,
		name: "initial_event_store",
		sql: `
			CREATE TABLE IF NOT EXISTS events (
				id INTEGER PRIMARY KEY,
				session_id TEXT NOT NULL,
				ts INTEGER NOT NULL,
				type TEXT NOT NULL,
				payload TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
			CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);

			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				cost_usd REAL DEFAULT 0,
				agent_spawns INTEGER DEFAULT 0,
				tool_calls INTEGER DEFAULT 0,
				status TEXT NOT NULL DEFAULT 'active'
			);

			CREATE TABLE IF NOT EXISTS router_decisions (
				id INTEGER PRIMARY KEY,
				session_id TEXT NOT NULL,
				ts INTEGER NOT NULL,
				skill TEXT NOT NULL,
				tier TEXT NOT NULL,
				reason TEXT,
				result TEXT
			);

			CREATE TABLE IF NOT EXISTS instincts (
				id INTEGER PRIMARY KEY,
				scope TEXT NOT NULL,
				pattern TEXT NOT NULL,
				evidence TEXT,
				examples TEXT,
				confidence REAL NOT NULL,
				ttl_expires_at INTEGER,
				status TEXT NOT NULL DEFAULT 'pending'
			);
		`,
	},
	{
		version: 2,
		name: "policy_decisions",
		sql: `
			CREATE TABLE IF NOT EXISTS policy_decisions (
				id INTEGER PRIMARY KEY,
				session_id TEXT NOT NULL,
				ts INTEGER NOT NULL,
				event_id INTEGER,
				host TEXT NOT NULL,
				rule_id TEXT NOT NULL,
				action TEXT NOT NULL,
				severity TEXT NOT NULL,
				tier TEXT NOT NULL,
				reason TEXT,
				enforced INTEGER NOT NULL,
				evidence TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_policy_decisions_session ON policy_decisions(session_id, ts);
			CREATE INDEX IF NOT EXISTS idx_policy_decisions_rule ON policy_decisions(rule_id, ts);
			CREATE INDEX IF NOT EXISTS idx_policy_decisions_action ON policy_decisions(action, ts);
		`,
	},
	{
		version: 3,
		name: "portable_execution_ledger",
		sql: `
			CREATE TABLE IF NOT EXISTS runs (
				run_id TEXT PRIMARY KEY,
				objective TEXT NOT NULL,
				acceptance_criteria TEXT NOT NULL,
				profile TEXT NOT NULL,
				host TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER,
				context TEXT,
				metadata TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);
			CREATE INDEX IF NOT EXISTS idx_runs_host ON runs(host, updated_at);

			CREATE TABLE IF NOT EXISTS phases (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				phase_id TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending',
				started_at INTEGER,
				ended_at INTEGER,
				host_mapping TEXT,
				metadata TEXT,
				UNIQUE(run_id, phase_id),
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_phases_run ON phases(run_id, phase_id);

			CREATE TABLE IF NOT EXISTS phase_events (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				phase_id TEXT NOT NULL,
				ts INTEGER NOT NULL,
				event_type TEXT NOT NULL,
				status TEXT,
				payload TEXT,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_phase_events_run_phase ON phase_events(run_id, phase_id, ts, id);

			CREATE TABLE IF NOT EXISTS scores (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				metric TEXT NOT NULL,
				value REAL NOT NULL,
				decision TEXT NOT NULL,
				threshold REAL,
				rationale TEXT,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_scores_run_metric ON scores(run_id, metric, ts);

			CREATE TABLE IF NOT EXISTS artifacts (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				relative_path TEXT NOT NULL,
				sha256 TEXT NOT NULL,
				byte_length INTEGER NOT NULL,
				redaction_status TEXT NOT NULL,
				metadata TEXT,
				created_at INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at);

			CREATE TABLE IF NOT EXISTS evidence (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				phase_id TEXT,
				evidence_id TEXT NOT NULL,
				kind TEXT NOT NULL,
				result TEXT NOT NULL,
				command TEXT,
				exit_code INTEGER,
				rationale TEXT,
				artifact_id INTEGER,
				metadata TEXT,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
				FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
			);
			CREATE INDEX IF NOT EXISTS idx_evidence_run_phase ON evidence(run_id, phase_id, ts);
			CREATE INDEX IF NOT EXISTS idx_evidence_result ON evidence(result, ts);

			CREATE TABLE IF NOT EXISTS capabilities (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				capability_id TEXT NOT NULL,
				support TEXT NOT NULL,
				confidence REAL NOT NULL,
				source TEXT NOT NULL,
				details TEXT,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_capabilities_run ON capabilities(run_id, capability_id);

			CREATE TABLE IF NOT EXISTS host_events (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				host TEXT NOT NULL,
				event_type TEXT NOT NULL,
				normalized_status TEXT,
				payload TEXT,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_host_events_run ON host_events(run_id, ts, id);

			CREATE TABLE IF NOT EXISTS decisions (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				phase_id TEXT,
				decision_type TEXT NOT NULL,
				decision TEXT NOT NULL,
				rationale TEXT NOT NULL,
				override INTEGER NOT NULL DEFAULT 0,
				expires_at INTEGER,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_decisions_run ON decisions(run_id, ts);

			CREATE TABLE IF NOT EXISTS learning_patterns (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				state TEXT NOT NULL,
				pattern TEXT NOT NULL,
				confidence REAL NOT NULL,
				evidence_id INTEGER,
				promoted_at INTEGER,
				retired_at INTEGER,
				metadata TEXT,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
				FOREIGN KEY(evidence_id) REFERENCES evidence(id)
			);
			CREATE INDEX IF NOT EXISTS idx_learning_patterns_scope ON learning_patterns(scope, state, confidence);

			CREATE TABLE IF NOT EXISTS policy_violations (
				id INTEGER PRIMARY KEY,
				run_id TEXT NOT NULL,
				policy_id TEXT NOT NULL,
				severity TEXT NOT NULL,
				message TEXT NOT NULL,
				blocked INTEGER NOT NULL DEFAULT 0,
				evidence_id INTEGER,
				ts INTEGER NOT NULL,
				FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
				FOREIGN KEY(evidence_id) REFERENCES evidence(id)
			);
			CREATE INDEX IF NOT EXISTS idx_policy_violations_run ON policy_violations(run_id, severity, ts);
		`,
	},
];

const ROUTED_SKILL: RoutedSkill = "do";

export function resolveStorePath(
	scope: StoreScope = "project",
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.PAVEDA_STORE_PATH) {
		return env.PAVEDA_STORE_PATH;
	}

	if (scope === "user") {
		return join(resolveHomeDirectory(env), ".paveda", "ledger", "paveda.db");
	}

	return join(cwd, ".paveda", "ledger", "paveda.db");
}

export class EventStore {
	readonly path: string;
	readonly database: DatabaseSync;

	constructor(path = resolveStorePath()) {
		this.path = path;
		assertStorePathIsSafe(path);
		ensureStoreDirectory(path);
		assertStorePathIsSafe(path);
		this.database = openInitializedDatabase(path);
		protectStoreFile(path);
	}

	append(input: AppendEventInput): EventRecord {
		const ts = input.ts ?? Date.now();
		const payload = input.payload ?? {};
		const payloadJson = JSON.stringify(payload);

		this.ensureSession(input.sessionId, ts);

		const result = this.database
			.prepare("INSERT INTO events (session_id, ts, type, payload) VALUES (?, ?, ?, ?)")
			.run(input.sessionId, ts, input.type, payloadJson);

		this.materializeSession(input.sessionId, input.type, ts, payload);

		return {
			id: Number(result.lastInsertRowid),
			sessionId: input.sessionId,
			ts,
			type: input.type,
			payload,
		};
	}

	appendRouterDecision(input: AppendRouterDecisionInput): RouterDecision {
		const ts = input.ts ?? Date.now();
		const skill = input.skill ?? ROUTED_SKILL;
		assertRoutedSkill(skill);
		this.ensureSession(input.sessionId, ts);

		const result = this.database
			.prepare(
				[
					"INSERT INTO router_decisions",
					"(session_id, ts, skill, tier, reason, result)",
					"VALUES (?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(input.sessionId, ts, skill, input.tier, input.reason ?? null, input.result ?? null);

		return {
			id: Number(result.lastInsertRowid),
			sessionId: input.sessionId,
			ts,
			skill,
			tier: input.tier,
			reason: input.reason ?? null,
			result: input.result ?? null,
		};
	}

	appendInstinct(input: AppendInstinctInput): InstinctRecord {
		assertInstinctScope(input.scope);
		assertInstinctPattern(input.pattern);
		assertInstinctConfidence(input.confidence);
		if (input.status !== undefined) {
			assertInstinctStatus(input.status);
		}

		const examplesJson =
			input.examples === undefined ? null : (JSON.stringify(input.examples) ?? null);
		const ttlExpiresAt = input.ttlExpiresAt ?? null;
		if (ttlExpiresAt !== null && (!Number.isFinite(ttlExpiresAt) || ttlExpiresAt < 0)) {
			throw new Error("Instinct ttlExpiresAt must be a non-negative number");
		}

		const result = this.database
			.prepare(
				[
					"INSERT INTO instincts",
					"(scope, pattern, evidence, examples, confidence, ttl_expires_at, status)",
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.scope,
				input.pattern,
				input.evidence ?? null,
				examplesJson,
				input.confidence,
				ttlExpiresAt,
				input.status ?? "pending",
			);

		const instinct = this.getInstinct(Number(result.lastInsertRowid));
		if (!instinct) {
			throw new Error("Failed to read appended instinct");
		}

		return instinct;
	}

	appendPolicyDecision(input: AppendPolicyDecisionInput): PolicyDecisionRecord {
		const ts = input.ts ?? Date.now();
		assertNonEmptyString(input.host, "Policy decision host");
		assertNonEmptyString(input.ruleId, "Policy decision ruleId");
		assertPolicyDecisionAction(input.action);
		assertRuntimePolicySeverity(input.severity);
		assertEnforcementTier(input.tier);
		const evidence = input.evidence ?? {};
		const evidenceJson = JSON.stringify(evidence);

		this.ensureSession(input.sessionId, ts);

		const result = this.database
			.prepare(
				[
					"INSERT INTO policy_decisions",
					"(session_id, ts, event_id, host, rule_id, action, severity, tier, reason, enforced, evidence)",
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.sessionId,
				ts,
				input.eventId ?? null,
				input.host,
				input.ruleId,
				input.action,
				input.severity,
				input.tier,
				input.reason ?? null,
				input.enforced ? 1 : 0,
				evidenceJson,
			);

		return {
			id: Number(result.lastInsertRowid),
			sessionId: input.sessionId,
			ts,
			eventId: input.eventId ?? null,
			host: input.host,
			ruleId: input.ruleId,
			action: input.action,
			severity: input.severity,
			tier: input.tier,
			reason: input.reason ?? null,
			enforced: input.enforced,
			evidence,
		};
	}

	replay(sessionId: string, options: ReplayOptions = {}): EventRecord[] {
		const rows =
			options.since === undefined
				? (this.database
						.prepare(
							"SELECT id, session_id, ts, type, payload FROM events WHERE session_id = ? ORDER BY ts, id",
						)
						.all(sessionId) as EventRow[])
				: (this.database
						.prepare(
							[
								"SELECT id, session_id, ts, type, payload FROM events",
								"WHERE session_id = ? AND ts >= ?",
								"ORDER BY ts, id",
							].join(" "),
						)
						.all(sessionId, options.since) as EventRow[]);

		return rows.map(mapEventRow);
	}

	summarizeSession(sessionId: string): SessionSummary | null {
		const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as
			| SessionRow
			| undefined;

		return row ? mapSessionRow(row) : null;
	}

	listSessions(statusOrOptions?: SessionStatus | ListSessionsOptions): SessionSummary[] {
		const options =
			typeof statusOrOptions === "string" ? { status: statusOrOptions } : (statusOrOptions ?? {});
		const conditions: string[] = [];
		const values: Array<number | string> = [];

		if (options.status) {
			conditions.push("status = ?");
			values.push(options.status);
		}

		if (options.since !== undefined) {
			conditions.push("started_at >= ?");
			values.push(options.since);
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM sessions${where} ORDER BY started_at DESC`)
			.all(...values) as SessionRow[];

		return rows.map(mapSessionRow);
	}

	routerLineage(sessionId: string, options: RouterLineageOptions = {}): RouterDecision[] {
		const rows =
			options.since === undefined
				? (this.database
						.prepare(
							[
								"SELECT id, session_id, ts, skill, tier, reason, result",
								"FROM router_decisions",
								"WHERE session_id = ?",
								"ORDER BY ts, id",
							].join(" "),
						)
						.all(sessionId) as RouterDecisionRow[])
				: (this.database
						.prepare(
							[
								"SELECT id, session_id, ts, skill, tier, reason, result",
								"FROM router_decisions",
								"WHERE session_id = ? AND ts >= ?",
								"ORDER BY ts, id",
							].join(" "),
						)
						.all(sessionId, options.since) as RouterDecisionRow[]);

		return rows.map(mapRouterDecisionRow);
	}

	policyLineage(sessionId: string, options: { since?: number } = {}): PolicyDecisionRecord[] {
		const rows =
			options.since === undefined
				? (this.database
						.prepare(
							[
								"SELECT id, session_id, ts, event_id, host, rule_id, action, severity, tier,",
								"reason, enforced, evidence",
								"FROM policy_decisions",
								"WHERE session_id = ?",
								"ORDER BY ts, id",
							].join(" "),
						)
						.all(sessionId) as PolicyDecisionRow[])
				: (this.database
						.prepare(
							[
								"SELECT id, session_id, ts, event_id, host, rule_id, action, severity, tier,",
								"reason, enforced, evidence",
								"FROM policy_decisions",
								"WHERE session_id = ? AND ts >= ?",
								"ORDER BY ts, id",
							].join(" "),
						)
						.all(sessionId, options.since) as PolicyDecisionRow[]);

		return rows.map(mapPolicyDecisionRow);
	}

	routerHistory(skill: RoutedSkill = ROUTED_SKILL, limit = 20): RouterDecision[] {
		assertRoutedSkill(skill);
		const rows = this.database
			.prepare(
				[
					"SELECT id, session_id, ts, skill, tier, reason, result",
					"FROM router_decisions",
					"WHERE skill = ?",
					"ORDER BY ts DESC, id DESC",
					"LIMIT ?",
				].join(" "),
			)
			.all(skill, limit) as RouterDecisionRow[];

		return rows.map(mapRouterDecisionRow).reverse();
	}

	listRouterDecisions(options: ListRouterDecisionsOptions = {}): RouterDecision[] {
		const conditions: string[] = [];
		const values: Array<number | string> = [];

		if (options.skill) {
			assertRoutedSkill(options.skill);
			conditions.push("skill = ?");
			values.push(options.skill);
		}

		if (options.since !== undefined) {
			conditions.push("ts >= ?");
			values.push(options.since);
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const limit = options.limit ?? 50;
		const rows = this.database
			.prepare(
				[
					"SELECT id, session_id, ts, skill, tier, reason, result",
					"FROM router_decisions",
					where,
					"ORDER BY ts DESC, id DESC",
					"LIMIT ?",
				].join(" "),
			)
			.all(...values, limit) as RouterDecisionRow[];

		return rows.map(mapRouterDecisionRow);
	}

	listInstincts(options: ListInstinctsOptions = {}): InstinctRecord[] {
		this.expireInstincts(options.now ?? Date.now());

		const conditions: string[] = [];
		const values: Array<number | string> = [];

		if (options.scope) {
			assertInstinctScope(options.scope);
			conditions.push("scope = ?");
			values.push(options.scope);
		}

		if (options.status) {
			assertInstinctStatus(options.status);
			conditions.push("status = ?");
			values.push(options.status);
		} else if (!options.includeExpired) {
			conditions.push("status != 'expired'");
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const limit = options.limit ?? 50;
		const rows = this.database
			.prepare(
				[
					"SELECT id, scope, pattern, evidence, examples, confidence, ttl_expires_at, status",
					"FROM instincts",
					where,
					"ORDER BY confidence DESC, id DESC",
					"LIMIT ?",
				].join(" "),
			)
			.all(...values, limit) as InstinctRow[];

		return rows.map(mapInstinctRow);
	}

	listPolicyDecisions(options: ListPolicyDecisionsOptions = {}): PolicyDecisionRecord[] {
		const conditions: string[] = [];
		const values: Array<number | string> = [];

		if (options.sessionId) {
			conditions.push("session_id = ?");
			values.push(options.sessionId);
		}

		if (options.host) {
			conditions.push("host = ?");
			values.push(options.host);
		}

		if (options.ruleId) {
			conditions.push("rule_id = ?");
			values.push(options.ruleId);
		}

		if (options.action) {
			assertPolicyDecisionAction(options.action);
			conditions.push("action = ?");
			values.push(options.action);
		}

		if (options.since !== undefined) {
			conditions.push("ts >= ?");
			values.push(options.since);
		}

		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const limit = options.limit ?? 50;
		const rows = this.database
			.prepare(
				[
					"SELECT id, session_id, ts, event_id, host, rule_id, action, severity, tier,",
					"reason, enforced, evidence",
					"FROM policy_decisions",
					where,
					"ORDER BY ts DESC, id DESC",
					"LIMIT ?",
				].join(" "),
			)
			.all(...values, limit) as PolicyDecisionRow[];

		return rows.map(mapPolicyDecisionRow);
	}

	updateInstinctStatus(id: number, status: InstinctStatus): InstinctRecord | null {
		assertPositiveInteger(id, "Instinct id");
		assertInstinctStatus(status);

		this.database.prepare("UPDATE instincts SET status = ? WHERE id = ?").run(status, id);
		return this.getInstinct(id);
	}

	createRun(input: CreateRunInput): RunRecord {
		assertNonEmptyString(input.objective, "Run objective");
		const runId = input.runId ?? generateUuidV7();
		assertUuidV7(runId, "Run id");
		const profile = input.profile ?? "strict";
		assertPavedaProfile(profile);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Run timestamp");

		this.database
			.prepare(
				[
					"INSERT INTO runs",
					"(run_id, objective, acceptance_criteria, profile, host, status, created_at, updated_at, completed_at, context, metadata)",
					"VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)",
				].join(" "),
			)
			.run(
				runId,
				input.objective,
				jsonStringify(input.acceptanceCriteria ?? []),
				profile,
				input.host ?? null,
				ts,
				ts,
				jsonStringifyNullable(input.context),
				jsonStringifyNullable(input.metadata),
			);

		return this.getRun(runId) ?? failRead("created run", runId);
	}

	getRun(runId: string): RunRecord | null {
		assertUuidV7(runId, "Run id");
		const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as
			| RunRow
			| undefined;

		return row ? mapRunRow(row) : null;
	}

	completeRun(runId: string, status: RunStatus = "completed", ts = Date.now()): RunRecord {
		assertUuidV7(runId, "Run id");
		assertRunStatus(status);
		assertFiniteTimestamp(ts, "Run completion timestamp");
		this.database
			.prepare("UPDATE runs SET status = ?, updated_at = ?, completed_at = ? WHERE run_id = ?")
			.run(status, ts, ts, runId);

		return this.getRun(runId) ?? failRead("completed run", runId);
	}

	upsertPhase(input: UpsertPhaseInput): PhaseRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.phaseId, "Phase id");
		const status = input.status ?? "pending";
		assertPhaseStatus(status);
		const startedAt = input.startedAt ?? null;
		const endedAt = input.endedAt ?? null;
		assertOptionalTimestamp(startedAt, "Phase startedAt");
		assertOptionalTimestamp(endedAt, "Phase endedAt");
		this.assertRunExists(input.runId);

		this.database
			.prepare(
				[
					"INSERT INTO phases",
					"(run_id, phase_id, status, started_at, ended_at, host_mapping, metadata)",
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
					"ON CONFLICT(run_id, phase_id) DO UPDATE SET",
					"status = excluded.status,",
					"started_at = excluded.started_at,",
					"ended_at = excluded.ended_at,",
					"host_mapping = excluded.host_mapping,",
					"metadata = excluded.metadata",
				].join(" "),
			)
			.run(
				input.runId,
				input.phaseId,
				status,
				startedAt,
				endedAt,
				jsonStringifyNullable(input.hostMapping),
				jsonStringifyNullable(input.metadata),
			);
		this.touchRun(input.runId, endedAt ?? startedAt ?? Date.now());

		return this.getPhase(input.runId, input.phaseId) ?? failRead("upserted phase", input.phaseId);
	}

	getPhase(runId: string, phaseId: string): PhaseRecord | null {
		assertUuidV7(runId, "Run id");
		assertNonEmptyString(phaseId, "Phase id");
		const row = this.database
			.prepare("SELECT * FROM phases WHERE run_id = ? AND phase_id = ?")
			.get(runId, phaseId) as PhaseRow | undefined;

		return row ? mapPhaseRow(row) : null;
	}

	appendPhaseEvent(input: AppendPhaseEventInput): PhaseEventRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.phaseId, "Phase id");
		assertNonEmptyString(input.eventType, "Phase event type");
		if (input.status !== undefined && input.status !== null) {
			assertPhaseStatus(input.status);
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Phase event timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO phase_events",
					"(run_id, phase_id, ts, event_type, status, payload)",
					"VALUES (?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.phaseId,
				ts,
				input.eventType,
				input.status ?? null,
				jsonStringifyNullable(input.payload),
			);
		this.touchRun(input.runId, ts);

		return (
			this.getPhaseEvent(Number(result.lastInsertRowid)) ?? failRead("phase event", input.phaseId)
		);
	}

	listPhaseEvents(runId: string, phaseId?: string): PhaseEventRecord[] {
		assertUuidV7(runId, "Run id");
		const rows =
			phaseId === undefined
				? (this.database
						.prepare("SELECT * FROM phase_events WHERE run_id = ? ORDER BY ts, id")
						.all(runId) as PhaseEventRow[])
				: (this.database
						.prepare("SELECT * FROM phase_events WHERE run_id = ? AND phase_id = ? ORDER BY ts, id")
						.all(runId, phaseId) as PhaseEventRow[]);

		return rows.map(mapPhaseEventRow);
	}

	recordScore(input: RecordScoreInput): ScoreRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.metric, "Score metric");
		assertFiniteNumber(input.value, "Score value");
		assertScoreDecision(input.decision);
		if (input.threshold !== undefined && input.threshold !== null) {
			assertFiniteNumber(input.threshold, "Score threshold");
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Score timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO scores",
					"(run_id, metric, value, decision, threshold, rationale, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.metric,
				input.value,
				input.decision,
				input.threshold ?? null,
				input.rationale ?? null,
				ts,
			);
		this.touchRun(input.runId, ts);

		return this.getScore(Number(result.lastInsertRowid)) ?? failRead("score", input.metric);
	}

	listScores(runId: string): ScoreRecord[] {
		assertUuidV7(runId, "Run id");
		const rows = this.database
			.prepare("SELECT * FROM scores WHERE run_id = ? ORDER BY ts, id")
			.all(runId) as ScoreRow[];
		return rows.map(mapScoreRow);
	}

	recordArtifact(input: RecordArtifactInput): ArtifactRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.kind, "Artifact kind");
		assertSafeRelativeArtifactPath(input.relativePath);
		assertSha256(input.sha256);
		assertNonNegativeInteger(input.byteLength, "Artifact byteLength");
		assertArtifactRedactionStatus(input.redactionStatus);
		this.assertRunExists(input.runId);
		const createdAt = input.createdAt ?? Date.now();
		assertFiniteTimestamp(createdAt, "Artifact timestamp");

		const result = this.database
			.prepare(
				[
					"INSERT INTO artifacts",
					"(run_id, kind, relative_path, sha256, byte_length, redaction_status, metadata, created_at)",
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.kind,
				input.relativePath,
				input.sha256,
				input.byteLength,
				input.redactionStatus,
				jsonStringifyNullable(input.metadata),
				createdAt,
			);
		this.touchRun(input.runId, createdAt);

		return (
			this.getArtifact(Number(result.lastInsertRowid)) ?? failRead("artifact", input.relativePath)
		);
	}

	writeArtifact(input: WriteArtifactInput): ArtifactRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.fileName, "Artifact fileName");
		assertSafeArtifactFileName(input.fileName);
		const bytes = typeof input.content === "string" ? Buffer.from(input.content) : input.content;
		const relativePath = join(input.runId, input.fileName);
		const artifactRoot = resolveArtifactRoot(this.path);
		const artifactPath = join(artifactRoot, relativePath);
		assertPathDoesNotUseSymlinks(artifactPath, "Artifact path");
		mkdirSync(dirname(artifactPath), { recursive: true });
		assertPathDoesNotUseSymlinks(artifactPath, "Artifact path");
		writeFileSync(artifactPath, bytes);
		return this.recordArtifact({
			runId: input.runId,
			kind: input.kind,
			relativePath,
			sha256: sha256(bytes),
			byteLength: bytes.byteLength,
			redactionStatus: input.redactionStatus ?? "not_required",
			metadata: input.metadata,
			createdAt: input.createdAt,
		});
	}

	listArtifacts(runId: string): ArtifactRecord[] {
		assertUuidV7(runId, "Run id");
		const rows = this.database
			.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id")
			.all(runId) as ArtifactRow[];
		return rows.map(mapArtifactRow);
	}

	recordEvidence(input: RecordEvidenceInput): EvidenceRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.evidenceId, "Evidence id");
		assertNonEmptyString(input.kind, "Evidence kind");
		assertEvidenceResult(input.result);
		if (input.exitCode !== undefined && input.exitCode !== null) {
			assertInteger(input.exitCode, "Evidence exitCode");
		}
		if (input.artifactId !== undefined && input.artifactId !== null) {
			assertPositiveInteger(input.artifactId, "Artifact id");
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Evidence timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO evidence",
					"(run_id, phase_id, evidence_id, kind, result, command, exit_code, rationale, artifact_id, metadata, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.phaseId ?? null,
				input.evidenceId,
				input.kind,
				input.result,
				input.command ?? null,
				input.exitCode ?? null,
				input.rationale ?? null,
				input.artifactId ?? null,
				jsonStringifyNullable(input.metadata),
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getEvidence(Number(result.lastInsertRowid)) ?? failRead("evidence", input.evidenceId)
		);
	}

	listEvidence(runId: string): EvidenceRecord[] {
		assertUuidV7(runId, "Run id");
		const rows = this.database
			.prepare("SELECT * FROM evidence WHERE run_id = ? ORDER BY ts, id")
			.all(runId) as EvidenceRow[];
		return rows.map(mapEvidenceRow);
	}

	recordCapability(input: RecordCapabilityInput): CapabilityRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.capabilityId, "Capability id");
		assertNonEmptyString(input.support, "Capability support");
		assertConfidence(input.confidence, "Capability confidence");
		assertNonEmptyString(input.source, "Capability source");
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Capability timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO capabilities",
					"(run_id, capability_id, support, confidence, source, details, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.capabilityId,
				input.support,
				input.confidence,
				input.source,
				jsonStringifyNullable(input.details),
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getCapability(Number(result.lastInsertRowid)) ??
			failRead("capability", input.capabilityId)
		);
	}

	appendHostEvent(input: AppendHostEventInput): HostEventRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.host, "Host");
		assertNonEmptyString(input.eventType, "Host event type");
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Host event timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO host_events",
					"(run_id, host, event_type, normalized_status, payload, ts)",
					"VALUES (?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.host,
				input.eventType,
				input.normalizedStatus ?? null,
				jsonStringifyNullable(input.payload),
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getHostEvent(Number(result.lastInsertRowid)) ?? failRead("host event", input.eventType)
		);
	}

	listHostEvents(runId: string): HostEventRecord[] {
		assertUuidV7(runId, "Run id");
		return this.database
			.prepare("SELECT * FROM host_events WHERE run_id = ? ORDER BY ts, id")
			.all(runId)
			.map((row) => mapHostEventRow(row as HostEventRow));
	}

	recordDecision(input: RecordDecisionInput): DecisionRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.decisionType, "Decision type");
		assertNonEmptyString(input.decision, "Decision");
		assertNonEmptyString(input.rationale, "Decision rationale");
		if (input.expiresAt !== undefined && input.expiresAt !== null) {
			assertFiniteTimestamp(input.expiresAt, "Decision expiresAt");
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Decision timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO decisions",
					"(run_id, phase_id, decision_type, decision, rationale, override, expires_at, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.phaseId ?? null,
				input.decisionType,
				input.decision,
				input.rationale,
				input.override ? 1 : 0,
				input.expiresAt ?? null,
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getDecision(Number(result.lastInsertRowid)) ?? failRead("decision", input.decisionType)
		);
	}

	listDecisions(runId: string): DecisionRecord[] {
		assertUuidV7(runId, "Run id");
		const rows = this.database
			.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY ts, id")
			.all(runId) as DecisionRow[];
		return rows.map(mapDecisionRow);
	}

	recordLearningPattern(input: RecordLearningPatternInput): LearningPatternRecord {
		assertUuidV7(input.runId, "Run id");
		assertLearningScope(input.scope);
		assertLearningState(input.state);
		assertNonEmptyString(input.pattern, "Learning pattern");
		assertConfidence(input.confidence, "Learning confidence");
		if (input.evidenceId !== undefined && input.evidenceId !== null) {
			assertPositiveInteger(input.evidenceId, "Evidence id");
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Learning timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO learning_patterns",
					"(run_id, scope, state, pattern, confidence, evidence_id, promoted_at, retired_at, metadata, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.scope,
				input.state,
				input.pattern,
				input.confidence,
				input.evidenceId ?? null,
				input.state === "promoted" ? ts : null,
				input.state === "retired" ? ts : null,
				jsonStringifyNullable(input.metadata),
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getLearningPattern(Number(result.lastInsertRowid)) ??
			failRead("learning pattern", input.pattern)
		);
	}

	listLearningPatterns(options: ListLearningPatternsOptions = {}): LearningPatternRecord[] {
		const conditions: string[] = [];
		const values: Array<number | string> = [];

		if (options.runId) {
			assertUuidV7(options.runId, "Run id");
			conditions.push("run_id = ?");
			values.push(options.runId);
		}

		if (options.scope) {
			assertLearningScope(options.scope);
			conditions.push("scope = ?");
			values.push(options.scope);
		}

		if (options.state) {
			assertLearningState(options.state);
			conditions.push("state = ?");
			values.push(options.state);
		}

		const limit = options.limit ?? 50;
		assertPositiveInteger(limit, "Learning list limit");
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM learning_patterns${where} ORDER BY ts DESC, id DESC LIMIT ?`)
			.all(...values, limit) as LearningPatternRow[];
		return rows.map(mapLearningPatternRow);
	}

	updateLearningPatternState(input: UpdateLearningPatternStateInput): LearningPatternRecord | null {
		assertPositiveInteger(input.id, "Learning pattern id");
		assertLearningState(input.state);
		const existing = this.getLearningPattern(input.id);
		if (!existing) {
			return null;
		}
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Learning state timestamp");
		const promotedAt = input.state === "promoted" ? ts : existing.promotedAt;
		const retiredAt = input.state === "retired" ? ts : existing.retiredAt;
		const metadata = input.metadata === undefined ? existing.metadata : input.metadata;

		this.database
			.prepare(
				[
					"UPDATE learning_patterns SET",
					"state = ?, promoted_at = ?, retired_at = ?, metadata = ?",
					"WHERE id = ?",
				].join(" "),
			)
			.run(input.state, promotedAt, retiredAt, jsonStringifyNullable(metadata), input.id);
		this.touchRun(existing.runId, ts);

		return this.getLearningPattern(input.id);
	}

	recordPolicyViolation(input: RecordPolicyViolationInput): PolicyViolationRecord {
		assertUuidV7(input.runId, "Run id");
		assertNonEmptyString(input.policyId, "Policy id");
		assertPolicySeverity(input.severity);
		assertNonEmptyString(input.message, "Policy violation message");
		if (input.evidenceId !== undefined && input.evidenceId !== null) {
			assertPositiveInteger(input.evidenceId, "Evidence id");
		}
		this.assertRunExists(input.runId);
		const ts = input.ts ?? Date.now();
		assertFiniteTimestamp(ts, "Policy violation timestamp");
		const result = this.database
			.prepare(
				[
					"INSERT INTO policy_violations",
					"(run_id, policy_id, severity, message, blocked, evidence_id, ts)",
					"VALUES (?, ?, ?, ?, ?, ?, ?)",
				].join(" "),
			)
			.run(
				input.runId,
				input.policyId,
				input.severity,
				input.message,
				input.blocked ? 1 : 0,
				input.evidenceId ?? null,
				ts,
			);
		this.touchRun(input.runId, ts);

		return (
			this.getPolicyViolation(Number(result.lastInsertRowid)) ??
			failRead("policy violation", input.policyId)
		);
	}

	listPolicyViolations(runId: string): PolicyViolationRecord[] {
		assertUuidV7(runId, "Run id");
		const rows = this.database
			.prepare("SELECT * FROM policy_violations WHERE run_id = ? ORDER BY ts, id")
			.all(runId) as PolicyViolationRow[];
		return rows.map(mapPolicyViolationRow);
	}

	schemaVersion(): number {
		return currentSchemaVersion(this.database);
	}

	close(): void {
		this.database.close();
	}

	private ensureSession(sessionId: string, startedAt: number): void {
		this.database
			.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
			.run(sessionId, startedAt);
	}

	private materializeSession(
		sessionId: string,
		eventType: string,
		ts: number,
		payload: unknown,
	): void {
		if (eventType === "tool.execute.before") {
			this.database
				.prepare("UPDATE sessions SET tool_calls = tool_calls + 1 WHERE id = ?")
				.run(sessionId);
		}

		if (eventType === "agent.spawned") {
			this.database
				.prepare("UPDATE sessions SET agent_spawns = agent_spawns + 1 WHERE id = ?")
				.run(sessionId);
		}

		const costUsd = getCostUsd(payload);
		if (costUsd !== undefined) {
			this.database
				.prepare("UPDATE sessions SET cost_usd = max(cost_usd, ?) WHERE id = ?")
				.run(costUsd, sessionId);
		}

		if (eventType === "session.completed") {
			this.database
				.prepare("UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?")
				.run(ts, getCompletionStatus(payload), sessionId);
		}
	}

	private expireInstincts(now: number): void {
		if (!Number.isFinite(now)) {
			throw new Error("Instinct expiry time must be a finite number");
		}

		this.database
			.prepare(
				[
					"UPDATE instincts SET status = 'expired'",
					"WHERE ttl_expires_at IS NOT NULL",
					"AND ttl_expires_at <= ?",
					"AND status IN ('pending', 'active')",
				].join(" "),
			)
			.run(now);
	}

	private getInstinct(id: number): InstinctRecord | null {
		const row = this.database
			.prepare(
				[
					"SELECT id, scope, pattern, evidence, examples, confidence, ttl_expires_at, status",
					"FROM instincts",
					"WHERE id = ?",
				].join(" "),
			)
			.get(id) as InstinctRow | undefined;

		return row ? mapInstinctRow(row) : null;
	}

	private assertRunExists(runId: string): void {
		const row = this.database.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
		if (!row) {
			throw new Error(`Run does not exist: ${runId}`);
		}
	}

	private touchRun(runId: string, updatedAt: number): void {
		this.database
			.prepare("UPDATE runs SET updated_at = max(updated_at, ?) WHERE run_id = ?")
			.run(updatedAt, runId);
	}

	private getPhaseEvent(id: number): PhaseEventRecord | null {
		const row = this.database.prepare("SELECT * FROM phase_events WHERE id = ?").get(id) as
			| PhaseEventRow
			| undefined;
		return row ? mapPhaseEventRow(row) : null;
	}

	private getScore(id: number): ScoreRecord | null {
		const row = this.database.prepare("SELECT * FROM scores WHERE id = ?").get(id) as
			| ScoreRow
			| undefined;
		return row ? mapScoreRow(row) : null;
	}

	private getArtifact(id: number): ArtifactRecord | null {
		const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as
			| ArtifactRow
			| undefined;
		return row ? mapArtifactRow(row) : null;
	}

	private getEvidence(id: number): EvidenceRecord | null {
		const row = this.database.prepare("SELECT * FROM evidence WHERE id = ?").get(id) as
			| EvidenceRow
			| undefined;
		return row ? mapEvidenceRow(row) : null;
	}

	private getCapability(id: number): CapabilityRecord | null {
		const row = this.database.prepare("SELECT * FROM capabilities WHERE id = ?").get(id) as
			| CapabilityRow
			| undefined;
		return row ? mapCapabilityRow(row) : null;
	}

	private getHostEvent(id: number): HostEventRecord | null {
		const row = this.database.prepare("SELECT * FROM host_events WHERE id = ?").get(id) as
			| HostEventRow
			| undefined;
		return row ? mapHostEventRow(row) : null;
	}

	private getDecision(id: number): DecisionRecord | null {
		const row = this.database.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
			| DecisionRow
			| undefined;
		return row ? mapDecisionRow(row) : null;
	}

	getLearningPattern(id: number): LearningPatternRecord | null {
		assertPositiveInteger(id, "Learning pattern id");
		const row = this.database.prepare("SELECT * FROM learning_patterns WHERE id = ?").get(id) as
			| LearningPatternRow
			| undefined;
		return row ? mapLearningPatternRow(row) : null;
	}

	private getPolicyViolation(id: number): PolicyViolationRecord | null {
		const row = this.database.prepare("SELECT * FROM policy_violations WHERE id = ?").get(id) as
			| PolicyViolationRow
			| undefined;
		return row ? mapPolicyViolationRow(row) : null;
	}
}

function ensureStoreDirectory(path: string): void {
	if (path === ":memory:") {
		return;
	}

	mkdirSync(dirname(path), { recursive: true });
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv): string {
	return env.HOME || env.USERPROFILE || homedir();
}

function assertStorePathIsSafe(path: string): void {
	if (path === ":memory:") {
		return;
	}

	assertPathDoesNotUseSymlinks(path, "EventStore path");
}

function protectStoreFile(path: string): void {
	if (path === ":memory:") {
		return;
	}

	chmodSync(path, 0o600);
}

function openInitializedDatabase(path: string): DatabaseSync {
	let lastError: unknown;

	for (let attempt = 0; attempt <= DEFAULT_STORE_OPEN_RETRIES; attempt += 1) {
		const database = new SqliteDatabaseSync(path, { timeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS });

		try {
			initializeDatabase(database);
			return database;
		} catch (error) {
			closeDatabaseQuietly(database);
			if (!isRetryableSqliteLockError(error) || attempt === DEFAULT_STORE_OPEN_RETRIES) {
				throw error;
			}

			lastError = error;
			sleepSync(DEFAULT_STORE_OPEN_RETRY_DELAY_MS * (attempt + 1));
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function initializeDatabase(database: DatabaseSync): void {
	database.exec(`
		PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS};
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;
	`);
	applyStoreMigrations(database);
}

function closeDatabaseQuietly(database: DatabaseSync): void {
	try {
		database.close();
	} catch {
		// Ignore close errors while recovering from a failed initialization attempt.
	}
}

function isRetryableSqliteLockError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	return /(?:database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED)/i.test(
		error.message,
	);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function applyStoreMigrations(database: DatabaseSync): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);

	const current = currentSchemaVersion(database);
	if (current > CURRENT_SCHEMA_VERSION) {
		throw new Error(
			`EventStore schema version ${current} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
		);
	}

	for (const migration of STORE_MIGRATIONS) {
		database.exec("BEGIN IMMEDIATE");
		try {
			if (migration.version > currentSchemaVersion(database)) {
				database.exec(migration.sql);
				database
					.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
					.run(migration.version, migration.name, Date.now());
			}
			database.exec("COMMIT");
		} catch (error) {
			rollbackQuietly(database);
			throw error;
		}
	}
}

function rollbackQuietly(database: DatabaseSync): void {
	try {
		database.exec("ROLLBACK");
	} catch {
		// Preserve the original migration error.
	}
}

function currentSchemaVersion(database: DatabaseSync): number {
	const row = database
		.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
		.get() as SchemaMigrationRow | undefined;

	return row?.version ?? 0;
}

function mapEventRow(row: EventRow): EventRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		ts: row.ts,
		type: row.type,
		payload: JSON.parse(row.payload),
	};
}

function mapSessionRow(row: SessionRow): SessionSummary {
	return {
		id: row.id,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		costUsd: row.cost_usd,
		agentSpawns: row.agent_spawns,
		toolCalls: row.tool_calls,
		status: row.status,
	};
}

function mapRouterDecisionRow(row: RouterDecisionRow): RouterDecision {
	return {
		id: row.id,
		sessionId: row.session_id,
		ts: row.ts,
		skill: row.skill,
		tier: row.tier,
		reason: row.reason,
		result: row.result,
	};
}

function mapInstinctRow(row: InstinctRow): InstinctRecord {
	return {
		id: row.id,
		scope: row.scope,
		pattern: row.pattern,
		evidence: row.evidence,
		examples: row.examples === null ? null : JSON.parse(row.examples),
		confidence: row.confidence,
		ttlExpiresAt: row.ttl_expires_at,
		status: row.status,
	};
}

function mapPolicyDecisionRow(row: PolicyDecisionRow): PolicyDecisionRecord {
	return {
		id: row.id,
		sessionId: row.session_id,
		ts: row.ts,
		eventId: row.event_id,
		host: row.host,
		ruleId: row.rule_id,
		action: row.action,
		severity: row.severity,
		tier: row.tier,
		reason: row.reason,
		enforced: row.enforced === 1,
		evidence: JSON.parse(row.evidence),
	};
}

function mapRunRow(row: RunRow): RunRecord {
	return {
		runId: row.run_id,
		objective: row.objective,
		acceptanceCriteria: parseJson(row.acceptance_criteria),
		profile: row.profile,
		host: row.host,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		completedAt: row.completed_at,
		context: parseNullableJson(row.context),
		metadata: parseNullableJson(row.metadata),
	};
}

function mapPhaseRow(row: PhaseRow): PhaseRecord {
	return {
		id: row.id,
		runId: row.run_id,
		phaseId: row.phase_id,
		status: row.status,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		hostMapping: parseNullableJson(row.host_mapping),
		metadata: parseNullableJson(row.metadata),
	};
}

function mapPhaseEventRow(row: PhaseEventRow): PhaseEventRecord {
	return {
		id: row.id,
		runId: row.run_id,
		phaseId: row.phase_id,
		ts: row.ts,
		eventType: row.event_type,
		status: row.status,
		payload: parseNullableJson(row.payload),
	};
}

function mapScoreRow(row: ScoreRow): ScoreRecord {
	return {
		id: row.id,
		runId: row.run_id,
		metric: row.metric,
		value: row.value,
		decision: row.decision,
		threshold: row.threshold,
		rationale: row.rationale,
		ts: row.ts,
	};
}

function mapArtifactRow(row: ArtifactRow): ArtifactRecord {
	return {
		id: row.id,
		runId: row.run_id,
		kind: row.kind,
		relativePath: row.relative_path,
		sha256: row.sha256,
		byteLength: row.byte_length,
		redactionStatus: row.redaction_status,
		metadata: parseNullableJson(row.metadata),
		createdAt: row.created_at,
	};
}

function mapEvidenceRow(row: EvidenceRow): EvidenceRecord {
	return {
		id: row.id,
		runId: row.run_id,
		phaseId: row.phase_id,
		evidenceId: row.evidence_id,
		kind: row.kind,
		result: row.result,
		command: row.command,
		exitCode: row.exit_code,
		rationale: row.rationale,
		artifactId: row.artifact_id,
		metadata: parseNullableJson(row.metadata),
		ts: row.ts,
	};
}

function mapCapabilityRow(row: CapabilityRow): CapabilityRecord {
	return {
		id: row.id,
		runId: row.run_id,
		capabilityId: row.capability_id,
		support: row.support,
		confidence: row.confidence,
		source: row.source,
		details: parseNullableJson(row.details),
		ts: row.ts,
	};
}

function mapHostEventRow(row: HostEventRow): HostEventRecord {
	return {
		id: row.id,
		runId: row.run_id,
		host: row.host,
		eventType: row.event_type,
		normalizedStatus: row.normalized_status,
		payload: parseNullableJson(row.payload),
		ts: row.ts,
	};
}

function mapDecisionRow(row: DecisionRow): DecisionRecord {
	return {
		id: row.id,
		runId: row.run_id,
		phaseId: row.phase_id,
		decisionType: row.decision_type,
		decision: row.decision,
		rationale: row.rationale,
		override: row.override === 1,
		expiresAt: row.expires_at,
		ts: row.ts,
	};
}

function mapLearningPatternRow(row: LearningPatternRow): LearningPatternRecord {
	return {
		id: row.id,
		runId: row.run_id,
		scope: row.scope,
		state: row.state,
		pattern: row.pattern,
		confidence: row.confidence,
		evidenceId: row.evidence_id,
		promotedAt: row.promoted_at,
		retiredAt: row.retired_at,
		metadata: parseNullableJson(row.metadata),
		ts: row.ts,
	};
}

function mapPolicyViolationRow(row: PolicyViolationRow): PolicyViolationRecord {
	return {
		id: row.id,
		runId: row.run_id,
		policyId: row.policy_id,
		severity: row.severity,
		message: row.message,
		blocked: row.blocked === 1,
		evidenceId: row.evidence_id,
		ts: row.ts,
	};
}

function getCompletionStatus(payload: unknown): SessionStatus {
	if (
		typeof payload === "object" &&
		payload !== null &&
		"status" in payload &&
		isSessionStatus(payload.status)
	) {
		return payload.status;
	}

	return "completed";
}

function getCostUsd(payload: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) {
		return undefined;
	}

	const costUsd = readNumberProperty(payload, "costUsd") ?? readNumberProperty(payload, "cost_usd");
	if (costUsd === undefined || costUsd < 0) {
		return undefined;
	}

	return costUsd;
}

function readNumberProperty(payload: object, key: string): number | undefined {
	if (!(key in payload)) {
		return undefined;
	}

	const value = (payload as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSessionStatus(value: unknown): value is SessionStatus {
	return value === "active" || value === "completed" || value === "failed" || value === "compacted";
}

function assertInstinctScope(value: unknown): asserts value is InstinctScope {
	if (value !== "project" && value !== "user") {
		throw new Error(`Invalid instinct scope: ${String(value)}`);
	}
}

function assertInstinctStatus(value: unknown): asserts value is InstinctStatus {
	if (value !== "pending" && value !== "active" && value !== "promoted" && value !== "expired") {
		throw new Error(`Invalid instinct status: ${String(value)}`);
	}
}

function assertRoutedSkill(value: unknown): asserts value is RoutedSkill {
	if (value !== ROUTED_SKILL) {
		throw new Error("PAL Router is only enabled for /do");
	}
}

function assertInstinctPattern(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error("Instinct pattern must not be empty");
	}
}

function assertInstinctConfidence(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("Instinct confidence must be between 0 and 1");
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
}

export function generateUuidV7(now = Date.now()): string {
	assertFiniteTimestamp(now, "UUID v7 timestamp");
	const timestamp = Math.floor(now);
	const bytes = randomBytes(16);
	bytes[0] = (timestamp / 0x10000000000) & 0xff;
	bytes[1] = (timestamp / 0x100000000) & 0xff;
	bytes[2] = (timestamp / 0x1000000) & 0xff;
	bytes[3] = (timestamp / 0x10000) & 0xff;
	bytes[4] = (timestamp / 0x100) & 0xff;
	bytes[5] = timestamp & 0xff;
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

function assertUuidV7(value: string, name: string): void {
	if (!UUID_V7_PATTERN.test(value)) {
		throw new Error(`${name} must be a UUID v7`);
	}
}

function assertPavedaProfile(value: unknown): asserts value is PavedaProfile {
	if (value !== "fast" && value !== "standard" && value !== "strict" && value !== "release") {
		throw new Error(`Invalid Paveda profile: ${String(value)}`);
	}
}

function assertRunStatus(value: unknown): asserts value is RunStatus {
	if (value !== "active" && value !== "completed" && value !== "failed" && value !== "blocked") {
		throw new Error(`Invalid run status: ${String(value)}`);
	}
}

function assertPhaseStatus(value: unknown): asserts value is PhaseStatus {
	if (
		value !== "pending" &&
		value !== "active" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "blocked" &&
		value !== "not_applicable"
	) {
		throw new Error(`Invalid phase status: ${String(value)}`);
	}
}

function assertEvidenceResult(value: unknown): asserts value is EvidenceResult {
	if (
		value !== "pass" &&
		value !== "fail" &&
		value !== "block" &&
		value !== "not_applicable" &&
		value !== "inconclusive"
	) {
		throw new Error(`Invalid evidence result: ${String(value)}`);
	}
}

function assertArtifactRedactionStatus(value: unknown): asserts value is ArtifactRedactionStatus {
	if (
		value !== "not_required" &&
		value !== "pending" &&
		value !== "redacted" &&
		value !== "failed"
	) {
		throw new Error(`Invalid artifact redaction status: ${String(value)}`);
	}
}

function assertScoreDecision(
	value: unknown,
): asserts value is "pass" | "warn" | "repair" | "block" {
	if (value !== "pass" && value !== "warn" && value !== "repair" && value !== "block") {
		throw new Error(`Invalid score decision: ${String(value)}`);
	}
}

function assertLearningScope(value: unknown): asserts value is InstinctScope | "shared" {
	if (value !== "project" && value !== "user" && value !== "shared") {
		throw new Error(`Invalid learning scope: ${String(value)}`);
	}
}

function assertLearningState(value: unknown): asserts value is LearningState {
	if (
		value !== "observed" &&
		value !== "candidate" &&
		value !== "validated" &&
		value !== "promoted" &&
		value !== "retired"
	) {
		throw new Error(`Invalid learning state: ${String(value)}`);
	}
}

function assertPolicySeverity(value: unknown): asserts value is PolicySeverity {
	if (value !== "info" && value !== "warning" && value !== "error" && value !== "block") {
		throw new Error(`Invalid policy severity: ${String(value)}`);
	}
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${name} must not be empty`);
	}
}

function assertPolicyDecisionAction(value: unknown): asserts value is PolicyDecisionAction {
	if (
		value !== "allow" &&
		value !== "warn" &&
		value !== "deny" &&
		value !== "ask" &&
		value !== "require_step" &&
		value !== "record_only"
	) {
		throw new Error(`Invalid policy decision action: ${String(value)}`);
	}
}

function assertRuntimePolicySeverity(value: unknown): asserts value is RuntimePolicySeverity {
	if (
		value !== "info" &&
		value !== "low" &&
		value !== "medium" &&
		value !== "high" &&
		value !== "critical"
	) {
		throw new Error(`Invalid policy decision severity: ${String(value)}`);
	}
}

function assertEnforcementTier(value: unknown): asserts value is EnforcementTier {
	if (value !== "block" && value !== "gate" && value !== "mediate" && value !== "verify") {
		throw new Error(`Invalid enforcement tier: ${String(value)}`);
	}
}

function assertFiniteNumber(value: number, name: string): void {
	if (!Number.isFinite(value)) {
		throw new Error(`${name} must be a finite number`);
	}
}

function assertInteger(value: number, name: string): void {
	if (!Number.isInteger(value)) {
		throw new Error(`${name} must be an integer`);
	}
}

function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}
}

function assertConfidence(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${name} must be between 0 and 1`);
	}
}

function assertFiniteTimestamp(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${name} must be a non-negative finite timestamp`);
	}
}

function assertOptionalTimestamp(value: number | null, name: string): void {
	if (value !== null) {
		assertFiniteTimestamp(value, name);
	}
}

function assertSha256(value: string): void {
	if (!/^[a-f0-9]{64}$/i.test(value)) {
		throw new Error("Artifact sha256 must be a 64-character hex digest");
	}
}

function assertSafeArtifactFileName(value: string): void {
	if (
		isAbsolute(value) ||
		value.includes("/") ||
		value.includes("\\") ||
		value === "." ||
		value === ".."
	) {
		throw new Error(`Artifact fileName must be a plain file name: ${value}`);
	}
	assertSafeRelativeArtifactPath(value);
}

function assertSafeRelativeArtifactPath(value: string): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("Artifact relativePath must not be empty");
	}
	if (isAbsolute(value)) {
		throw new Error(`Artifact relativePath must be relative: ${value}`);
	}
	const normalized = normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`Artifact relativePath must stay below artifact root: ${value}`);
	}
}

function jsonStringify(value: unknown): string {
	return JSON.stringify(value);
}

function jsonStringifyNullable(value: unknown): string | null {
	return value === undefined ? null : jsonStringify(value);
}

function parseJson(value: string): unknown {
	return JSON.parse(value);
}

function parseNullableJson(value: string | null): unknown {
	return value === null ? null : JSON.parse(value);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function resolveArtifactRoot(storePath: string): string {
	const ledgerDir = dirname(storePath);
	const pavedaDir = dirname(ledgerDir);
	if (basename(ledgerDir) === "ledger" && basename(pavedaDir) === ".paveda") {
		return join(pavedaDir, "artifacts");
	}
	return join(dirname(storePath), "artifacts");
}

function failRead(subject: string, id: string): never {
	throw new Error(`Failed to read ${subject}: ${id}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
