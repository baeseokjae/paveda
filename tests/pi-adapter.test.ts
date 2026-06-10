import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromPiHookPayload } from "../src/adapters/pi/index.js";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Pi adapter", () => {
	it("maps Pi tool_call extension payloads to dispatch inputs", () => {
		expect(
			fromPiHookPayload({
				event_name: "tool_call",
				session_id: "session-1",
				cwd: "/repo",
				toolName: "bash",
				input: { command: "pnpm test" },
			}),
		).toMatchObject({
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			hookName: "harness.destructive.guard",
			payload: {
				host: "pi",
				hookEventName: "tool_call",
				cwd: "/repo",
				tool: "Bash",
				raw: {
					tool_name: "bash",
					tool_input: { command: "pnpm test" },
				},
			},
		});
	});

	it("records Pi lifecycle command evidence through runtime dispatch", () => {
		const store = openTempStore();
		const run = store.createRun({
			objective: "Capture Pi command evidence",
			profile: "strict",
			host: "pi",
			ts: 90,
		});
		const input = fromPiHookPayload({
			event_name: "tool_result",
			session_id: "session-command",
			cwd: "/repo",
			paveda_run_id: run.runId,
			tool_use_id: "unit",
			toolName: "bash",
			input: { command: "pnpm test" },
			result: { exit_code: 0 },
		});

		const result = dispatchHookEvent(store, { ...input, ts: 100, config: config() });

		expect(result.hostLifecycle).toMatchObject({
			status: "recorded",
			hostEvent: {
				host: "pi",
				eventType: "pi.tool.completed",
				normalizedStatus: "completed",
			},
			evidence: {
				evidenceId: "pi-bash-unit",
				kind: "command",
				result: "pass",
				command: "pnpm test",
				exitCode: 0,
			},
		});

		store.close();
	});

	it("records enforced Pi policy decisions through runtime dispatch", () => {
		const store = openTempStore();
		const input = fromPiHookPayload({
			event_name: "tool_call",
			session_id: "session-2",
			toolName: "write",
			input: { path: "/repo/.env", content: "API_KEY=secret" },
		});

		const result = dispatchHookEvent(store, { ...input, ts: 100, config: config() });

		expect(result.agentEvent).toMatchObject({
			host: "pi",
			kind: "tool.requested",
			tool: {
				name: "Write",
				input: { file_path: "/repo/.env" },
			},
			fileMutation: {
				kind: "write",
				path: "/repo/.env",
			},
		});
		expect(result.policyDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					host: "pi",
					ruleId: "D-004",
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
	const dir = mkdtempSync(join(tmpdir(), "paveda-pi-adapter-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
