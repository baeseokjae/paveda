import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromCodexHookPayload } from "../src/adapters/codex/index.js";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Codex adapter", () => {
	it("maps Codex PreToolUse payloads to dispatch inputs", () => {
		expect(
			fromCodexHookPayload({
				hook_event_name: "PreToolUse",
				session_id: "session-1",
				cwd: "/repo",
				tool_name: "Bash",
				tool_input: { command: "pnpm test" },
				permission_mode: "default",
				model: "gpt-5.3-codex",
			}),
		).toMatchObject({
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			hookName: "harness.destructive.guard",
			payload: {
				host: "codex",
				hookEventName: "PreToolUse",
				cwd: "/repo",
				tool: "Bash",
				permissionMode: "default",
				model: "gpt-5.3-codex",
			},
		});
	});

	it("maps Codex PermissionRequest payloads to tool policy dispatch", () => {
		expect(
			fromCodexHookPayload({
				hook_event_name: "PermissionRequest",
				session_id: "session-2",
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			}),
		).toMatchObject({
			sessionId: "session-2",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			hookName: "paveda.lifecycle.permission.request",
			payload: {
				host: "codex",
				hookEventName: "PermissionRequest",
				tool: "Bash",
			},
		});
	});

	it("maps Codex UserPromptSubmit payloads to prompt events", () => {
		expect(
			fromCodexHookPayload({
				hook_event_name: "UserPromptSubmit",
				session_id: "session-3",
				prompt: "only plan this change",
			}),
		).toMatchObject({
			sessionId: "session-3",
			lifecycle: "prompt.submitted",
			matcher: "session",
			hookName: "paveda.lifecycle.prompt.submit",
			payload: {
				host: "codex",
				hookEventName: "UserPromptSubmit",
				prompt: "only plan this change",
			},
		});
	});

	it("records Codex policy decisions through runtime dispatch", () => {
		const store = openTempStore();
		const input = fromCodexHookPayload({
			hook_event_name: "PreToolUse",
			session_id: "session-4",
			tool_name: "Bash",
			tool_input: { command: "echo API_KEY=secret >> .env" },
		});

		const result = dispatchHookEvent(store, { ...input, ts: 100, config: config() });

		expect(result.agentEvent).toMatchObject({
			host: "codex",
			kind: "tool.requested",
			tool: {
				name: "Bash",
				input: { command: "echo API_KEY=secret >> .env" },
			},
		});
		expect(result.policyDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					host: "codex",
					ruleId: "D-001",
					action: "deny",
					tier: "block",
					enforced: true,
				}),
			]),
		);

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
	const dir = mkdtempSync(join(tmpdir(), "paveda-codex-adapter-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
