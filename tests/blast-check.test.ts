import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { evaluateBlastCheck } from "../src/hooks/blast-check.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("blast check", () => {
	it("warns for package dependency changes", () => {
		expect(
			evaluateBlastCheck({
				toolName: "Edit",
				toolInput: {
					file_path: "/repo/package.json",
					new_string: '"dependencies": { "react": "^19.0.0" }',
				},
			}),
		).toMatchObject({
			warnings: [
				"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
			],
			additionalContext:
				"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
		});
	});

	it("warns for Python dependency manifest changes", () => {
		for (const content of [
			'dependencies = ["fastapi>=0.115"]',
			"[tool.poetry.dependencies]\npython = '^3.12'\nhttpx = '^0.28'",
			"[tool.poetry.group.dev.dependencies]\npytest = '^8.0'",
			"[dependency-groups]\ndev = ['pytest>=8']",
		]) {
			expect(
				evaluateBlastCheck({
					toolName: "Edit",
					toolInput: {
						file_path: "/repo/pyproject.toml",
						new_string: content,
					},
				}),
			).toMatchObject({
				warnings: [
					"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
				],
			});
		}
	});

	it("warns for database schema changes", () => {
		expect(
			evaluateBlastCheck({
				toolName: "Write",
				toolInput: { file_path: "/repo/db/schema.ts", content: "export const users = {};" },
			}),
		).toMatchObject({
			warnings: ["Database schema change detected. Check whether a migration is required."],
		});
		expect(
			evaluateBlastCheck({
				toolName: "Edit",
				toolInput: { file_path: "/repo/prisma/schema.prisma", new_string: "model User {}" },
			}),
		).toMatchObject({
			warnings: ["Database schema change detected. Check whether a migration is required."],
		});
	});

	it("warns for apply_patch manifest and schema changes", () => {
		expect(
			evaluateBlastCheck({
				toolName: "apply_patch",
				toolInput: {
					patch: [
						"*** Begin Patch",
						"*** Update File: package.json",
						'+    "dependencies": { "typescript": "^5.6.0" },',
						"*** Update File: db/schema.ts",
						"+export const users = {};",
						"*** End Patch",
					].join("\n"),
				},
			}),
		).toMatchObject({
			warnings: [
				"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
				"Database schema change detected. Check whether a migration is required.",
			],
		});
	});

	it("records blast check evaluation through runtime dispatch", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Edit",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Edit",
				raw: {
					tool_input: {
						file_path: "/repo/package.json",
						new_string: '"devDependencies": { "vitest": "^2.0.0" }',
					},
				},
			},
			config: config(),
		});

		expect(result.blastCheck).toMatchObject({
			warnings: [
				"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
			],
		});
		expect(store.replay("session-1").at(-1)).toMatchObject({
			type: "blast.check.evaluated",
			payload: {
				additionalContext:
					"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
			},
		});

		store.close();
	});

	it("records apply_patch blast and destructive checks through runtime dispatch", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-apply-patch",
			lifecycle: "tool.execute.before",
			matcher: "apply_patch",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "apply_patch",
				raw: {
					tool_input: {
						patch: [
							"*** Begin Patch",
							"*** Update File: package.json",
							'+    "dependencies": { "typescript": "^5.6.0" },',
							"*** Update File: .env.local",
							"+TOKEN=secret",
							"*** End Patch",
						].join("\n"),
					},
				},
			},
			config: config(),
		});

		expect(result.hook.name).toBe("harness.blast.check");
		expect(result.blastCheck).toMatchObject({
			warnings: [
				"Dependency manifest change detected. Sync the project lockfile or dependency metadata.",
			],
		});
		expect(result.destructiveGuard).toMatchObject({
			decision: "deny",
			ruleId: "D-004",
		});

		store.close();
	});
});

function config(): PavedaConfig {
	return {
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: false,
		sessionStartMaxChars: 8000,
		costGuardMaxMinutes: 120,
		costGuardAgentWarningThreshold: 5,
		costGuardAgentCompactInterval: 3,
	};
}

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-blast-check-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
