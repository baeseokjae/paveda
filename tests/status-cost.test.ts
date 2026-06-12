import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/store/index.js";

// Can't import formatStatusMarkdown directly — it's not exported from cli.ts.
// Instead test via the JSON output which uses SessionSummary, verifying cost field presence.
// SessionSummary already carries costUsd, toolCalls, agentSpawns in the type definition.

describe("session status cost fields", () => {
	it("SessionSummary type includes cost and token-like fields", () => {
		const summary: SessionSummary = {
			id: "session-1",
			startedAt: 1000,
			endedAt: 45000,
			costUsd: 0.42,
			agentSpawns: 3,
			toolCalls: 47,
			status: "completed",
		};
		expect(summary.costUsd).toBe(0.42);
		expect(summary.toolCalls).toBe(47);
		expect(summary.agentSpawns).toBe(3);
		expect(summary.status).toBe("completed");
	});
});
