import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { evaluateToolingEnforce } from "../src/hooks/tooling-enforce.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("tooling enforce", () => {
	it.each([
		["cat README.md", "T-001", "Read"],
		["head -n 20 README.md", "T-002", "Read"],
		["tail -n 20 README.md", "T-003", "Read"],
		["bat README.md", "T-004", "Read"],
		["grep -R TODO src", "T-005", "Grep"],
		["find src -name '*.ts'", "T-006", "Glob"],
		["sed -i '' 's/a/b/' file.txt", "T-007", "Edit"],
		["awk '{print $1}' file.txt", "T-008", "Edit/Read"],
		["echo hello > file.txt", "T-009", "Write"],
	])("denies %s with %s", (command, ruleId, alternative) => {
		expect(
			evaluateToolingEnforce({
				toolName: "Bash",
				toolInput: { command },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId,
			alternative,
		});
	});

	it("allows shell commands that do not replace built-in tools", () => {
		expect(
			evaluateToolingEnforce({
				toolName: "Bash",
				toolInput: { command: "pnpm test" },
			}),
		).toEqual({ decision: "allow" });
	});

	it.each([
		["pnpm test && grep TODO src/index.ts", "T-005", "Grep"],
		["printf ready ; find src -name '*.ts'", "T-006", "Glob"],
		["true | sed -n '1,10p' README.md", "T-007", "Edit"],
		["LC_ALL=C /bin/cat README.md", "T-001", "Read"],
	])("denies disallowed commands inside compound shell: %s", (command, ruleId, alternative) => {
		expect(
			evaluateToolingEnforce({
				toolName: "Bash",
				toolInput: { command },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId,
			alternative,
		});
	});

	it("records tooling enforcement through Bash runtime dispatch", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: {
					tool_input: { command: "grep TODO src/index.ts" },
				},
			},
			config: config(),
		});

		expect(result.toolingEnforce).toMatchObject({
			decision: "deny",
			ruleId: "T-005",
		});
		expect(
			store.replay("session-1").find((event) => event.type === "tooling.enforce.evaluated"),
		).toMatchObject({
			type: "tooling.enforce.evaluated",
			payload: {
				decision: "deny",
				ruleId: "T-005",
				alternative: "Grep",
			},
		});
		expect(result.policyDecisions).toMatchObject([
			{
				action: "deny",
				ruleId: "T-005",
				tier: "block",
				enforced: true,
			},
		]);

		store.close();
	});

	it("respects disabled tooling enforce selector while keeping destructive guard active", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-2",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: {
					tool_input: { command: "grep TODO src/index.ts" },
				},
			},
			config: config({
				disabledHooks: [
					{
						lifecycle: "tool.execute.before",
						matcher: "Bash",
						name: "harness.tooling.enforce",
					},
				],
			}),
		});

		expect(result.destructiveGuard).toMatchObject({ decision: "allow" });
		expect(result.toolingEnforce).toBeUndefined();
		expect(store.replay("session-2").map((event) => event.type)).not.toContain(
			"tooling.enforce.evaluated",
		);

		store.close();
	});

	it("keeps tooling enforce active when only destructive guard is disabled", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-3",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: {
					tool_input: { command: "grep TODO src/index.ts" },
				},
			},
			config: config({
				disabledHooks: [
					{
						lifecycle: "tool.execute.before",
						matcher: "Bash",
						name: "harness.destructive.guard",
					},
				],
			}),
		});

		expect(result.dispatched).toBe(true);
		expect(result.destructiveGuard).toBeUndefined();
		expect(result.toolingEnforce).toMatchObject({
			decision: "deny",
			ruleId: "T-005",
		});
		expect(store.replay("session-3").map((event) => event.type)).toContain(
			"tooling.enforce.evaluated",
		);

		store.close();
	});
});

function config(overrides: Partial<PavedaConfig> = {}): PavedaConfig {
	return {
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: false,
		sessionStartMaxChars: 8000,
		costGuardMaxMinutes: 120,
		costGuardAgentWarningThreshold: 5,
		costGuardAgentCompactInterval: 3,
		...overrides,
	};
}

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-tooling-enforce-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
