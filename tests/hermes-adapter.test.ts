import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fromHermesHookPayload } from "../src/adapters/hermes/index.js";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Hermes adapter", () => {
	it("maps Hermes pre_tool_call shell-hook payloads to dispatch inputs", () => {
		expect(
			fromHermesHookPayload({
				hook_event_name: "pre_tool_call",
				session_id: "session-1",
				cwd: "/repo",
				tool_name: "terminal",
				tool_input: { command: "pnpm test" },
			}),
		).toMatchObject({
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			hookName: "harness.destructive.guard",
			payload: {
				host: "hermes",
				hookEventName: "pre_tool_call",
				cwd: "/repo",
				tool: "Bash",
				raw: {
					tool_name: "terminal",
					tool_input: { command: "pnpm test" },
				},
			},
		});
	});

	it("records enforced Hermes policy decisions through runtime dispatch", () => {
		const store = openTempStore();
		const input = fromHermesHookPayload({
			hook_event_name: "pre_tool_call",
			session_id: "session-2",
			tool_name: "terminal",
			tool_input: { command: "rm -rf /" },
		});

		const result = dispatchHookEvent(store, { ...input, ts: 100, config: config() });

		expect(result.agentEvent).toMatchObject({
			host: "hermes",
			kind: "tool.requested",
			tool: {
				name: "Bash",
				input: { command: "rm -rf /" },
			},
		});
		expect(result.policyDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					host: "hermes",
					ruleId: "D-003",
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
	const dir = mkdtempSync(join(tmpdir(), "paveda-hermes-adapter-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
