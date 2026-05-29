import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRuntimeSmoke } from "../src/checks/runtime-smoke.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("runtime smoke", () => {
	it("records a synthetic hook session and verifies EventStore replay", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-"));
		tempDirs.push(cwd);
		const dbPath = join(cwd, ".harness", "store.db");

		const result = runRuntimeSmoke({
			cwd,
			dbPath,
			sessionId: "runtime-smoke-session",
			ts: 100,
			env: {},
		});

		expect(result).toMatchObject({
			ok: true,
			cwd,
			dbPath,
			sessionId: "runtime-smoke-session",
			eventTypes: [
				"hook.fired",
				"config.snapshot",
				"session.created",
				"hook.fired",
				"tool.execute.before",
				"destructive.guard.evaluated",
				"tooling.enforce.evaluated",
				"hook.fired",
				"session.completed",
			],
			summary: {
				id: "runtime-smoke-session",
				status: "completed",
				toolCalls: 1,
				endedAt: 102,
			},
		});

		const store = new EventStore(dbPath);
		expect(store.replay("runtime-smoke-session")).toHaveLength(9);
		store.close();
	});

	it("does not execute project hooks even when project hook env is enabled", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-no-hooks-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks", "PreToolUse", "Bash");
		mkdirSync(hooksDir, { recursive: true });
		const markerPath = join(cwd, "project-hook-ran");
		const hookPath = join(hooksDir, "marker.sh");
		writeFileSync(hookPath, `#!/bin/sh\ntouch '${markerPath}'\n`);
		chmodSync(hookPath, 0o755);

		const result = runRuntimeSmoke({
			cwd,
			dbPath: join(cwd, ".harness", "store.db"),
			sessionId: "runtime-smoke-no-project-hooks",
			env: { PAVEDA_PROJECT_HOOKS: "on" },
		});

		expect(result.ok).toBe(true);
		expect(existsSync(markerPath)).toBe(false);
		expect(result.eventTypes).not.toContain("project.hook.executed");
	});

	it("respects store path environment while using the target cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-env-store-"));
		tempDirs.push(cwd);
		const dbPath = join(cwd, "custom-store", "store.db");

		const result = runRuntimeSmoke({
			cwd,
			sessionId: "runtime-smoke-env-store",
			ts: 100,
			env: { PAVEDA_STORE_PATH: dbPath },
		});

		expect(result).toMatchObject({
			ok: true,
			cwd,
			dbPath,
			sessionId: "runtime-smoke-env-store",
		});
		expect(existsSync(dbPath)).toBe(true);
		expect(existsSync(join(cwd, ".harness", "store.db"))).toBe(false);
	});

	it("can target the user EventStore scope", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-user-scope-"));
		const home = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-home-"));
		tempDirs.push(cwd, home);
		const dbPath = join(home, ".harness", "store.db");

		const result = runRuntimeSmoke({
			cwd,
			sessionId: "runtime-smoke-user-scope",
			storeScope: "user",
			ts: 100,
			env: { HOME: home },
		});

		expect(result).toMatchObject({
			ok: true,
			cwd,
			dbPath,
			sessionId: "runtime-smoke-user-scope",
		});
		expect(existsSync(dbPath)).toBe(true);
		expect(existsSync(join(cwd, ".harness", "store.db"))).toBe(false);
	});

	it("fails before writing when cwd is missing", () => {
		const cwd = join(tmpdir(), "paveda-runtime-smoke-missing-cwd");

		expect(() =>
			runRuntimeSmoke({
				cwd,
				dbPath: join(cwd, ".harness", "store.db"),
				sessionId: "runtime-smoke-missing-cwd",
				env: {},
			}),
		).toThrow(`Runtime smoke cwd is not a directory: ${cwd}`);
		expect(existsSync(cwd)).toBe(false);
	});

	it("fails before writing when hook config env is invalid", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-runtime-smoke-invalid-env-"));
		tempDirs.push(cwd);
		const dbPath = join(cwd, ".harness", "store.db");

		expect(() =>
			runRuntimeSmoke({
				cwd,
				dbPath,
				sessionId: "runtime-smoke-invalid-env",
				env: { PAVEDA_SESSION_START_CONTEXT: "maybe" },
			}),
		).toThrow("Invalid PAVEDA_SESSION_START_CONTEXT: maybe");
		expect(existsSync(dbPath)).toBe(false);
	});
});
