import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCodexGoalHandoff,
	fromCodexHookPayload,
	normalizeCodexGoalLifecycleEvent,
	normalizeCodexGoalStatus,
} from "../src/adapters/codex/index.js";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { EventStore, type RunRecord } from "../src/store/index.js";

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

	it("maps Codex native goal statuses without replacing the native lifecycle", () => {
		expect(normalizeCodexGoalStatus("created")).toBe("active");
		expect(normalizeCodexGoalStatus("in_progress")).toBe("active");
		expect(normalizeCodexGoalStatus("completed")).toBe("completed");
		expect(normalizeCodexGoalStatus("blocked")).toBe("blocked");
		expect(normalizeCodexGoalStatus("failed")).toBe("failed");
	});

	it("normalizes goal progress and terminal lifecycle events", () => {
		const progress = normalizeCodexGoalLifecycleEvent({
			runId: "01900000-0000-7000-8000-000000000001",
			objective: "Refactor policy engine",
			nativeStatus: "in_progress",
			plan: [{ step: "verify contract" }],
			progress: { completedSteps: 1 },
		});
		expect(progress).toMatchObject({
			host: "codex",
			phaseId: "execute",
			eventType: "codex.goal.in_progress",
			normalizedStatus: "active",
			payload: {
				objective: "Refactor policy engine",
				nativeStatus: "in_progress",
				plan: [{ step: "verify contract" }],
				progress: { completedSteps: 1 },
			},
		});

		const completed = normalizeCodexGoalLifecycleEvent({
			runId: "01900000-0000-7000-8000-000000000001",
			nativeStatus: "completed",
		});
		expect(completed).toMatchObject({
			phaseId: "handoff",
			eventType: "codex.goal.completed",
			normalizedStatus: "completed",
		});
	});

	it("builds a Codex goal handoff from a Paveda run", () => {
		const run: RunRecord = {
			runId: "01900000-0000-7000-8000-000000000001",
			objective: "Implement Codex handoff",
			acceptanceCriteria: ["goal event", "status mapping"],
			profile: "strict",
			host: "codex",
			status: "active",
			createdAt: 1_000,
			updatedAt: 1_000,
			completedAt: null,
			context: { taskType: "code" },
			metadata: null,
		};

		const handoff = buildCodexGoalHandoff({
			run,
			taskType: "code",
			cwd: "/tmp/paveda-codex",
		});

		expect(handoff).toMatchObject({
			status: "native_handoff",
			primitive: "goal",
			eventType: "codex.goal.created",
			normalizedStatus: "active",
			phaseId: "intake",
			payload: {
				objective: "Implement Codex handoff",
				acceptanceCriteria: ["goal event", "status mapping"],
				taskType: "code",
				profile: "strict",
			},
		});
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
