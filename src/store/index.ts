import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";

const require = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const CURRENT_SCHEMA_VERSION = 1;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;
export const DEFAULT_STORE_OPEN_RETRIES = 8;
export const DEFAULT_STORE_OPEN_RETRY_DELAY_MS = 100;

export type SessionStatus = "active" | "completed" | "failed" | "compacted";

export type RouterTier = "frugal" | "standard" | "frontier";

export type RouterDecisionResult = "success" | "retry" | "abort";

export type RoutedSkill = "do";

export type InstinctScope = "project" | "user";

export type InstinctStatus = "pending" | "active" | "promoted" | "expired";

export type StoreScope = "project" | "user";

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
		return join(resolveHomeDirectory(env), ".harness", "store.db");
	}

	return join(cwd, ".harness", "store.db");
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

	updateInstinctStatus(id: number, status: InstinctStatus): InstinctRecord | null {
		assertPositiveInteger(id, "Instinct id");
		assertInstinctStatus(status);

		this.database.prepare("UPDATE instincts SET status = ? WHERE id = ?").run(status, id);
		return this.getInstinct(id);
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
