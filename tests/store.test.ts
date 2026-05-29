import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CURRENT_SCHEMA_VERSION,
	DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
	EventStore,
	resolveStorePath,
} from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("EventStore", () => {
	it("appends events and replays a session in order", () => {
		const store = openTempStore();

		store.append({
			sessionId: "session-1",
			type: "session.created",
			ts: 100,
			payload: { cwd: "/repo" },
		});
		store.append({
			sessionId: "session-1",
			type: "tool.execute.before",
			ts: 200,
			payload: { tool: "Read" },
		});
		store.append({
			sessionId: "session-1",
			type: "session.completed",
			ts: 300,
			payload: { status: "completed" },
		});

		expect(store.replay("session-1")).toMatchObject([
			{ sessionId: "session-1", ts: 100, type: "session.created", payload: { cwd: "/repo" } },
			{ sessionId: "session-1", ts: 200, type: "tool.execute.before", payload: { tool: "Read" } },
			{
				sessionId: "session-1",
				ts: 300,
				type: "session.completed",
				payload: { status: "completed" },
			},
		]);
		expect(store.summarizeSession("session-1")).toMatchObject({
			id: "session-1",
			startedAt: 100,
			endedAt: 300,
			toolCalls: 1,
			status: "completed",
		});

		store.close();
	});

	it("filters replayed events by timestamp", () => {
		const store = openTempStore();

		store.append({ sessionId: "session-filter", type: "session.created", ts: 100 });
		store.append({ sessionId: "session-filter", type: "tool.execute.before", ts: 200 });
		store.append({ sessionId: "session-filter", type: "session.completed", ts: 300 });

		expect(store.replay("session-filter", { since: 200 }).map((event) => event.type)).toEqual([
			"tool.execute.before",
			"session.completed",
		]);

		store.close();
	});

	it("records router decision lineage", () => {
		const store = openTempStore();

		store.appendRouterDecision({
			sessionId: "session-2",
			ts: 100,
			tier: "frugal",
			reason: "start",
			result: "retry",
		});
		store.appendRouterDecision({
			sessionId: "session-2",
			ts: 200,
			tier: "standard",
			reason: "escalate:retry",
			result: "success",
		});

		expect(store.routerLineage("session-2")).toMatchObject([
			{ sessionId: "session-2", ts: 100, skill: "do", tier: "frugal", result: "retry" },
			{ sessionId: "session-2", ts: 200, skill: "do", tier: "standard", result: "success" },
		]);

		store.close();
	});

	it("filters sessions and router lineage by timestamp", () => {
		const store = openTempStore();

		store.append({ sessionId: "old-session", type: "session.created", ts: 100 });
		store.append({ sessionId: "new-session", type: "session.created", ts: 300 });
		store.append({
			sessionId: "failed-new-session",
			type: "session.completed",
			ts: 400,
			payload: { status: "failed" },
		});
		store.appendRouterDecision({
			sessionId: "new-session",
			ts: 200,
			tier: "frugal",
			reason: "start",
			result: "retry",
		});
		store.appendRouterDecision({
			sessionId: "new-session",
			ts: 500,
			tier: "standard",
			reason: "escalate:retry",
			result: "success",
		});

		expect(store.listSessions({ since: 300 }).map((session) => session.id)).toEqual([
			"failed-new-session",
			"new-session",
		]);
		expect(
			store.listSessions({ status: "failed", since: 300 }).map((session) => session.id),
		).toEqual(["failed-new-session"]);
		expect(store.routerLineage("new-session", { since: 300 })).toMatchObject([
			{ tier: "standard", result: "success" },
		]);

		store.close();
	});

	it("materializes cumulative session cost from event payloads", () => {
		const store = openTempStore();

		store.append({
			sessionId: "session-cost",
			type: "session.created",
			ts: 100,
			payload: { costUsd: 0.25 },
		});
		store.append({
			sessionId: "session-cost",
			type: "tool.execute.before",
			ts: 200,
			payload: { cost_usd: 0.4 },
		});
		store.append({
			sessionId: "session-cost",
			type: "session.completed",
			ts: 300,
			payload: { status: "completed", costUsd: 0.3 },
		});

		expect(store.summarizeSession("session-cost")).toMatchObject({
			costUsd: 0.4,
			status: "completed",
		});

		store.close();
	});

	it("lists router decisions for export", () => {
		const store = openTempStore();

		store.appendRouterDecision({
			sessionId: "old-session",
			skill: "do",
			ts: 100,
			tier: "frugal",
			result: "retry",
		});
		store.appendRouterDecision({
			sessionId: "new-session",
			skill: "do",
			ts: 300,
			tier: "standard",
			result: "success",
		});

		expect(store.listRouterDecisions({ skill: "do", since: 200, limit: 1 })).toMatchObject([
			{
				sessionId: "new-session",
				skill: "do",
				tier: "standard",
				result: "success",
			},
		]);

		store.close();
	});

	it("refuses router decision lineage outside /do", () => {
		const store = openTempStore();

		expect(() =>
			store.appendRouterDecision({
				sessionId: "review-session",
				skill: "review" as never,
				tier: "frontier",
				result: "abort",
			}),
		).toThrow("PAL Router is only enabled for /do");
		expect(() => store.routerHistory("review" as never)).toThrow(
			"PAL Router is only enabled for /do",
		);
		expect(() => store.listRouterDecisions({ skill: "review" as never })).toThrow(
			"PAL Router is only enabled for /do",
		);

		store.close();
	});

	it("records and lists instincts by scope and status", () => {
		const store = openTempStore();

		const first = store.appendInstinct({
			scope: "project",
			pattern: "Run focused tests before broad checks",
			evidence: "Repeated broad checks surfaced unrelated failures.",
			examples: [{ command: "pnpm test -- --run tests/store.test.ts" }],
			confidence: 0.82,
			status: "active",
		});
		store.appendInstinct({
			scope: "user",
			pattern: "Prefer pnpm commands",
			confidence: 0.9,
			status: "pending",
		});

		expect(first).toMatchObject({
			scope: "project",
			pattern: "Run focused tests before broad checks",
			confidence: 0.82,
			status: "active",
			examples: [{ command: "pnpm test -- --run tests/store.test.ts" }],
		});
		expect(store.listInstincts({ scope: "project" })).toMatchObject([
			{ pattern: "Run focused tests before broad checks", status: "active" },
		]);
		expect(store.updateInstinctStatus(first.id, "promoted")).toMatchObject({
			id: first.id,
			status: "promoted",
		});
		expect(store.listInstincts({ status: "promoted" })).toMatchObject([
			{ id: first.id, status: "promoted" },
		]);

		store.close();
	});

	it("expires pending and active instincts by TTL while preserving promoted records", () => {
		const store = openTempStore();

		const expired = store.appendInstinct({
			scope: "project",
			pattern: "Old retry pattern",
			confidence: 0.6,
			ttlExpiresAt: 100,
			status: "active",
		});
		const promoted = store.appendInstinct({
			scope: "project",
			pattern: "Promoted pattern",
			confidence: 0.7,
			ttlExpiresAt: 100,
			status: "promoted",
		});
		const fresh = store.appendInstinct({
			scope: "project",
			pattern: "Fresh pattern",
			confidence: 0.8,
			ttlExpiresAt: 300,
			status: "pending",
		});

		expect(store.listInstincts({ now: 200 }).map((instinct) => instinct.id)).toEqual([
			fresh.id,
			promoted.id,
		]);
		expect(store.listInstincts({ status: "expired", now: 200 })).toMatchObject([
			{ id: expired.id, status: "expired" },
		]);
		expect(
			store.listInstincts({ includeExpired: true, now: 200 }).map((instinct) => instinct.id),
		).toEqual([fresh.id, promoted.id, expired.id]);

		store.close();
	});

	it("validates instinct records before writing", () => {
		const store = openTempStore();

		expect(() =>
			store.appendInstinct({
				scope: "project",
				pattern: "",
				confidence: 0.5,
			}),
		).toThrow("Instinct pattern must not be empty");
		expect(() =>
			store.appendInstinct({
				scope: "project",
				pattern: "Bad confidence",
				confidence: 1.5,
			}),
		).toThrow("Instinct confidence must be between 0 and 1");
		expect(() =>
			store.appendInstinct({
				scope: "workspace",
				pattern: "Bad scope",
				confidence: 0.5,
			} as never),
		).toThrow("Invalid instinct scope");

		store.close();
	});

	it("resolves standard harness store paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-store-path-"));
		tempDirs.push(dir);
		const cwd = process.cwd();
		const oldStorePath = process.env.PAVEDA_STORE_PATH;

		try {
			Reflect.deleteProperty(process.env, "PAVEDA_STORE_PATH");
			process.chdir(dir);

			expect(resolveStorePath("project")).toBe(join(process.cwd(), ".harness", "store.db"));
			expect(resolveStorePath("project", join(dir, "target-project"))).toBe(
				join(dir, "target-project", ".harness", "store.db"),
			);
			expect(resolveStorePath("user")).toBe(join(homedir(), ".harness", "store.db"));
			expect(
				resolveStorePath("user", join(dir, "target-project"), {
					HOME: join(dir, "fake-home"),
				}),
			).toBe(join(dir, "fake-home", ".harness", "store.db"));

			process.env.PAVEDA_STORE_PATH = join(dir, "custom.db");
			expect(resolveStorePath("project")).toBe(join(dir, "custom.db"));
			expect(resolveStorePath("project", join(dir, "target-project"))).toBe(join(dir, "custom.db"));
			expect(
				resolveStorePath("project", join(dir, "target-project"), {
					PAVEDA_STORE_PATH: join(dir, "env-store.db"),
				}),
			).toBe(join(dir, "env-store.db"));
		} finally {
			process.chdir(cwd);
			if (oldStorePath === undefined) {
				Reflect.deleteProperty(process.env, "PAVEDA_STORE_PATH");
			} else {
				process.env.PAVEDA_STORE_PATH = oldStorePath;
			}
		}
	});

	it("stores SQLite files with owner-only permissions", () => {
		const store = openTempStore();

		expect(statSync(store.path).mode & 0o777).toBe(0o600);

		store.close();
	});

	it("sets a busy timeout for overlapping CLI access", () => {
		const store = openTempStore();

		expect(store.database.prepare("PRAGMA busy_timeout").get()).toMatchObject({
			timeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
		});

		store.close();
	});

	it("refuses symlinked EventStore paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-store-symlink-"));
		tempDirs.push(dir);

		const fileLink = join(dir, "store.db");
		symlinkSync(join(dir, "external.db"), fileLink);
		expect(() => new EventStore(fileLink)).toThrow("EventStore path must not use symlinks");

		const realHarness = join(dir, "real-harness");
		const linkedHarness = join(dir, ".harness");
		mkdirSync(realHarness);
		symlinkSync(realHarness, linkedHarness);
		expect(() => new EventStore(join(linkedHarness, "store.db"))).toThrow(
			"EventStore path must not use symlinks",
		);
	});

	it("refuses EventStore paths below symlinked ancestors", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-store-symlink-ancestor-"));
		tempDirs.push(dir);

		const realRoot = join(dir, "real-root");
		const linkedRoot = join(dir, "linked-root");
		mkdirSync(realRoot);
		symlinkSync(realRoot, linkedRoot);

		expect(() => new EventStore(join(linkedRoot, "nested", "store.db"))).toThrow(
			"EventStore path must not use symlinks",
		);
	});

	it("records the applied schema migration version", () => {
		const store = openTempStore();

		expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
		expect(
			store.database
				.prepare("SELECT name FROM schema_migrations WHERE version = ?")
				.get(CURRENT_SCHEMA_VERSION),
		).toMatchObject({
			name: "initial_event_store",
		});

		store.close();
	});

	it("refuses stores created by a newer schema version", () => {
		const store = openTempStore();
		const path = store.path;
		store.database
			.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
			.run(CURRENT_SCHEMA_VERSION + 1, "future_schema", Date.now());
		store.close();

		expect(() => new EventStore(path)).toThrow("newer than supported version");
	});
});

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-store-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
