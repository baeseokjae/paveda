import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromClaudeCodeHookPayload } from "../src/adapters/claude-code/index.js";
import { type PavedaConfig, parseDisabledHooks } from "../src/core/index.js";
import {
	dispatchHookEvent,
	isHookEnabled,
	resolveHookDefinition,
} from "../src/hook-runtime/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("hook runtime", () => {
	it("dispatches enabled hook events into EventStore", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: { tool: "Bash" },
			config: config(),
		});

		expect(result.dispatched).toBe(true);
		expect(store.replay("session-1")).toMatchObject([
			{
				type: "hook.fired",
				payload: {
					hook: "harness.destructive.guard",
					lifecycle: "tool.execute.before",
					matcher: "Bash",
					profile: "standard",
				},
			},
			{ type: "tool.execute.before", payload: { tool: "Bash" } },
			{
				type: "destructive.guard.evaluated",
				payload: { decision: "allow", additionalContext: null },
			},
			{
				type: "tooling.enforce.evaluated",
				payload: { decision: "allow" },
			},
		]);
		expect(store.summarizeSession("session-1")).toMatchObject({ toolCalls: 1 });

		store.close();
	});

	it("filters hooks by profile and disabled selectors", () => {
		expect(
			isHookEnabled(
				resolveHookDefinition({
					sessionId: "s",
					lifecycle: "tool.execute.after",
					matcher: "Agent",
				}),
				{
					hookProfile: "minimal",
					disabledHooks: [],
				},
			),
		).toBe(false);

		expect(
			isHookEnabled(
				resolveHookDefinition({
					sessionId: "s",
					lifecycle: "tool.execute.before",
					matcher: "Bash",
				}),
				{
					hookProfile: "standard",
					disabledHooks: parseDisabledHooks("tool.execute.before:Bash:harness.destructive.guard"),
				},
			),
		).toBe(false);

		expect(
			isHookEnabled(
				resolveHookDefinition({
					sessionId: "s",
					lifecycle: "tool.execute.after",
					matcher: "Agent",
				}),
				{
					hookProfile: "standard",
					disabledHooks: parseDisabledHooks("tool.execute.after:*:*"),
				},
			),
		).toBe(false);

		expect(
			isHookEnabled(
				resolveHookDefinition({
					sessionId: "s",
					lifecycle: "tool.execute.before",
					matcher: "Bash",
				}),
				{
					hookProfile: "standard",
					disabledHooks: parseDisabledHooks("*:Bash:harness.destructive.guard"),
				},
			),
		).toBe(false);
	});

	it("keeps minimal profile to destructive guard without tooling companion", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-minimal",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: { raw: { tool_input: { command: "cat package.json" } } },
			config: config({ hookProfile: "minimal" }),
		});

		expect(result.dispatched).toBe(true);
		expect(result.hook.name).toBe("harness.destructive.guard");
		expect(store.replay("session-minimal").map((event) => event.type)).toEqual([
			"hook.fired",
			"tool.execute.before",
			"destructive.guard.evaluated",
		]);

		store.close();
	});

	it("records verbose dispatch metadata in strict profile", () => {
		const store = openTempStore();

		dispatchHookEvent(store, {
			sessionId: "session-strict",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: { tool: "Bash", raw: { tool_input: { command: "pnpm test" } } },
			projectHooks: false,
			config: config({ hookProfile: "strict" }),
		});

		expect(store.replay("session-strict")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "hook.verbose",
					payload: {
						hook: "harness.destructive.guard",
						lifecycle: "tool.execute.before",
						matcher: "Bash",
						payloadKeys: ["raw", "tool"],
						projectHooksEnabled: false,
					},
				}),
			]),
		);

		store.close();
	});

	it("freezes hook config at session start for later hook events", () => {
		const store = openTempStore();

		dispatchHookEvent(store, {
			sessionId: "session-config-freeze",
			lifecycle: "session.created",
			matcher: "session",
			ts: 100,
			payload: { raw: { hook_event_name: "SessionStart" } },
			config: config({ hookProfile: "standard" }),
		});
		const later = dispatchHookEvent(store, {
			sessionId: "session-config-freeze",
			lifecycle: "tool.execute.after",
			matcher: "Agent",
			ts: 200,
			payload: { raw: { tool_response: { agentId: "agent-1" } } },
			config: config({ hookProfile: "minimal" }),
		});
		const events = store.replay("session-config-freeze");

		expect(later.dispatched).toBe(true);
		expect(later.hook.name).toBe("harness.cost.guard");
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "config.snapshot",
					payload: expect.objectContaining({ hookProfile: "standard" }),
				}),
				expect.objectContaining({
					type: "cost.guard.evaluated",
				}),
			]),
		);

		store.close();
	});

	it("freezes hook config even when the session context hook is disabled", () => {
		const store = openTempStore();

		const sessionStart = dispatchHookEvent(store, {
			sessionId: "session-config-disabled-start",
			lifecycle: "session.created",
			matcher: "session",
			ts: 100,
			payload: { raw: { hook_event_name: "SessionStart" } },
			config: config({
				hookProfile: "standard",
				disabledHooks: parseDisabledHooks("session.created:session:harness.session.context"),
			}),
		});
		const later = dispatchHookEvent(store, {
			sessionId: "session-config-disabled-start",
			lifecycle: "tool.execute.after",
			matcher: "Agent",
			ts: 200,
			payload: { raw: { tool_response: { agentId: "agent-1" } } },
			config: config({ hookProfile: "minimal" }),
		});
		const events = store.replay("session-config-disabled-start");

		expect(sessionStart).toMatchObject({ dispatched: false, reason: "disabled" });
		expect(sessionStart.events).toMatchObject([
			{
				type: "config.snapshot",
				payload: expect.objectContaining({ hookProfile: "standard" }),
			},
		]);
		expect(later.dispatched).toBe(true);
		expect(later.hook.name).toBe("harness.cost.guard");
		expect(events.map((event) => event.type)).toEqual([
			"config.snapshot",
			"hook.fired",
			"tool.execute.after",
			"agent.spawned",
			"cost.guard.evaluated",
		]);

		store.close();
	});

	it("uses the hook payload cwd for session context", () => {
		const projectCwd = makeGitRepo();
		const launchCwd = mkdtempSync(join(tmpdir(), "paveda-hook-runtime-launch-"));
		tempDirs.push(launchCwd);
		const previousCwd = process.cwd();
		const store = openTempStore();

		try {
			process.chdir(launchCwd);

			const result = dispatchHookEvent(store, {
				sessionId: "session-context-cwd",
				lifecycle: "session.created",
				matcher: "session",
				ts: 100,
				payload: {
					cwd: projectCwd,
					raw: {
						hook_event_name: "SessionStart",
						session_id: "session-context-cwd",
						cwd: projectCwd,
					},
				},
				config: config({ sessionStartContext: true }),
			});

			expect(result.sessionContext?.cwd).toBe(projectCwd);
			expect(store.replay("session-context-cwd")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "session.created",
						payload: expect.objectContaining({
							sessionContext: expect.objectContaining({ cwd: projectCwd }),
						}),
					}),
				]),
			);
		} finally {
			process.chdir(previousCwd);
			store.close();
		}
	});

	it("records project hook executions from .harness/hooks", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-runtime-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const hookPath = join(hooksDir, "check-docs-needed.sh");
		writeFileSync(
			hookPath,
			'#!/bin/sh\necho \'{"hookSpecificOutput":{"additionalContext":"docs"}}\'\n',
		);
		chmodSync(hookPath, 0o755);
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-project-hooks",
			lifecycle: "tool.execute.after",
			matcher: "Edit",
			hookName: "paveda.lifecycle.tool.after",
			payload: {
				cwd,
				raw: {
					hook_event_name: "PostToolUse",
					session_id: "session-project-hooks",
					tool_name: "Edit",
				},
			},
			config: config({ projectHooks: true }),
		});

		expect(result.projectHooks?.executions).toHaveLength(1);
		expect(store.replay("session-project-hooks")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "project.hook.executed",
					payload: expect.objectContaining({ name: "check-docs-needed.sh" }),
				}),
			]),
		);

		store.close();
	});

	it("skips project hook execution unless explicitly enabled", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-runtime-disabled-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const hookPath = join(hooksDir, "should-not-run.sh");
		writeFileSync(hookPath, "#!/bin/sh\necho unexpected\n");
		chmodSync(hookPath, 0o755);
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-project-hooks-disabled",
			lifecycle: "tool.execute.after",
			matcher: "Edit",
			hookName: "paveda.lifecycle.tool.after",
			payload: {
				cwd,
				raw: {
					hook_event_name: "PostToolUse",
					session_id: "session-project-hooks-disabled",
					tool_name: "Edit",
				},
			},
			config: config(),
		});

		expect(result.projectHooks).toBeUndefined();
		expect(
			store
				.replay("session-project-hooks-disabled")
				.some((event) => event.type === "project.hook.executed"),
		).toBe(false);

		store.close();
	});
});

describe("Claude Code adapter", () => {
	it("maps Claude Code PreToolUse payloads to dispatch inputs", () => {
		expect(
			fromClaudeCodeHookPayload({
				hook_event_name: "PreToolUse",
				session_id: "session-2",
				cwd: "/repo",
				tool_name: "Bash",
				tool_input: { command: "pnpm test" },
			}),
		).toMatchObject({
			sessionId: "session-2",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			hookName: "harness.destructive.guard",
			payload: {
				host: "claude-code",
				hookEventName: "PreToolUse",
				cwd: "/repo",
				tool: "Bash",
			},
		});
	});

	it("marks Stop payloads as completed sessions", () => {
		const store = openTempStore();
		const input = fromClaudeCodeHookPayload({
			hook_event_name: "Stop",
			session_id: "session-3",
			stop_hook_active: false,
		});

		dispatchHookEvent(store, { ...input, ts: 200, config: config() });

		expect(store.summarizeSession("session-3")).toMatchObject({
			id: "session-3",
			endedAt: 200,
			status: "completed",
		});

		store.close();
	});

	it("maps Claude Code PostToolUse Bash payloads to test cleanup", () => {
		expect(
			fromClaudeCodeHookPayload({
				hook_event_name: "PostToolUse",
				session_id: "session-4",
				tool_name: "Bash",
				tool_input: { command: "pnpm test" },
			}),
		).toMatchObject({
			sessionId: "session-4",
			lifecycle: "tool.execute.after",
			matcher: "Bash",
			hookName: "harness.test.process.cleanup",
		});
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
	const dir = mkdtempSync(join(tmpdir(), "paveda-hook-runtime-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "paveda-hook-runtime-git-"));
	tempDirs.push(dir);

	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	writeFileSync(join(dir, "tracked.txt"), "initial");
	execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

	return dir;
}
