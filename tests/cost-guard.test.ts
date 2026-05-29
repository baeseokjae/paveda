import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { evaluateCostGuard } from "../src/hooks/cost-guard.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("cost guard", () => {
	it("warns when session elapsed time exceeds the configured maximum", () => {
		const store = openTempStore();

		store.append({
			sessionId: "session-1",
			type: "session.created",
			ts: 0,
			payload: {},
		});
		const result = evaluateCostGuard(store, {
			sessionId: "session-1",
			ts: 121 * 60_000,
			config: config(),
		});

		expect(result.elapsedMinutes).toBe(121);
		expect(result.additionalContext).toContain("2h 1m");

		store.close();
	});

	it("records Agent spawns and emits compact guidance through runtime dispatch", () => {
		const store = openTempStore();

		for (let i = 1; i <= 3; i += 1) {
			dispatchHookEvent(store, {
				sessionId: "session-2",
				lifecycle: "tool.execute.after",
				matcher: "Agent",
				ts: i,
				payload: {
					raw: {
						tool_use_id: `tool-${i}`,
						tool_response: { agentId: `agent-${i}` },
					},
				},
				config: config({ costGuardAgentWarningThreshold: 5 }),
			});
		}

		expect(store.summarizeSession("session-2")).toMatchObject({
			agentSpawns: 3,
			toolCalls: 0,
		});
		const events = store.replay("session-2");
		expect(events.filter((event) => event.type === "agent.spawned")).toHaveLength(3);
		expect(events.at(-1)).toMatchObject({
			type: "cost.guard.evaluated",
			payload: {
				agentSpawns: 3,
				warnings: ["Agent spawn count is 3. Consider /compact if context is getting large."],
				additionalContext: "Agent spawn count is 3. Consider /compact if context is getting large.",
			},
		});

		store.close();
	});

	it("escalates guidance after the agent warning threshold", () => {
		const store = openTempStore();

		for (let i = 1; i <= 6; i += 1) {
			dispatchHookEvent(store, {
				sessionId: "session-3",
				lifecycle: "tool.execute.after",
				matcher: "Agent",
				ts: i,
				payload: {},
				config: config(),
			});
		}

		expect(store.replay("session-3").at(-1)).toMatchObject({
			type: "cost.guard.evaluated",
			payload: {
				agentSpawns: 6,
				warnings: ["Agent spawn count is 6. Consider /compact before spawning more agents."],
			},
		});

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
	const dir = mkdtempSync(join(tmpdir(), "paveda-cost-guard-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
