import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordRouteDecision, routeSkill } from "../src/router/index.js";
import { EventStore, type RouterDecision } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("PAL router", () => {
	it("starts /do at frugal and ignores other skills", () => {
		expect(routeSkill({ skill: "do" })).toMatchObject({
			enabled: true,
			skill: "do",
			tier: "frugal",
			reason: "start",
		});
		expect(routeSkill({ skill: "review" })).toMatchObject({
			enabled: false,
			skill: "review",
			reason: "disabled:skill",
		});
	});

	it("disables /do when loaded skill metadata does not opt into the router", () => {
		expect(routeSkill({ skill: "do", routerEnabled: false })).toMatchObject({
			enabled: false,
			skill: "do",
			tier: "standard",
			reason: "disabled:skill-router",
		});
		expect(routeSkill({ skill: "do", routerEnabled: true })).toMatchObject({
			enabled: true,
			tier: "frugal",
		});
	});

	it("escalates one tier for failure signals", () => {
		expect(
			routeSkill({
				history: [decision({ tier: "frugal", result: "success" })],
				signals: { toolRetries: 4 },
			}),
		).toMatchObject({
			tier: "standard",
			reason: "escalate:tool-retries",
		});

		expect(
			routeSkill({
				history: [decision({ tier: "standard", result: "success" })],
				signals: { verifyFailures: 1, ambiguityScore: 0.4, elapsedMinutes: 31 },
			}),
		).toMatchObject({
			tier: "frontier",
			reason: "escalate:verify-failure,ambiguity,elapsed-time",
		});
	});

	it("blocks /do when ambiguity exceeds the selected skill threshold", () => {
		expect(
			routeSkill({
				ambiguityRequired: 0.2,
				signals: { ambiguityScore: 0.21 },
			}),
		).toMatchObject({
			enabled: true,
			blocked: true,
			tier: "frugal",
			reason: "blocked:ambiguity",
			ambiguityRequired: 0.2,
		});

		expect(
			routeSkill({
				ambiguityRequired: 0.2,
				signals: { ambiguityScore: 0.2 },
			}),
		).toMatchObject({
			enabled: true,
			blocked: false,
			tier: "frugal",
			reason: "start",
		});
	});

	it("continues the last successful tier and downgrades after three successes", () => {
		expect(
			routeSkill({
				history: [
					decision({ tier: "standard", result: "success", ts: 1 }),
					decision({ tier: "standard", result: "success", ts: 2 }),
				],
			}),
		).toMatchObject({
			tier: "standard",
			reason: "continue:last-success",
		});

		expect(
			routeSkill({
				history: [
					decision({ tier: "standard", result: "success", ts: 1 }),
					decision({ tier: "standard", result: "success", ts: 2 }),
					decision({ tier: "standard", result: "success", ts: 3 }),
				],
			}),
		).toMatchObject({
			tier: "frugal",
			reason: "downgrade:3-successes",
		});
	});

	it("does not downgrade when recent successes are interrupted by failures", () => {
		expect(
			routeSkill({
				history: [
					decision({ tier: "standard", result: "success", ts: 1 }),
					decision({ tier: "standard", result: "retry", ts: 2 }),
					decision({ tier: "standard", result: "success", ts: 3 }),
					decision({ tier: "standard", result: "success", ts: 4 }),
				],
			}),
		).toMatchObject({
			tier: "standard",
			reason: "continue:last-success",
		});

		expect(
			routeSkill({
				history: [
					decision({ tier: "standard", result: "success", ts: 1 }),
					decision({ tier: "standard", result: "success", ts: 2 }),
					decision({ tier: "frugal", reason: "downgrade:3-successes", result: "retry", ts: 3 }),
				],
			}),
		).toMatchObject({
			tier: "standard",
			reason: "continue:last-success",
		});
	});

	it("records decisions into EventStore history", () => {
		const store = openTempStore();

		const first = recordRouteDecision(store, {
			sessionId: "session-1",
			ts: 100,
			result: "success",
		});
		const second = recordRouteDecision(store, {
			sessionId: "session-2",
			ts: 200,
			result: "retry",
			signals: { toolRetries: 4 },
		});

		expect(first).toMatchObject({ sessionId: "session-1", tier: "frugal", result: "success" });
		expect(second).toMatchObject({
			sessionId: "session-2",
			tier: "standard",
			reason: "escalate:tool-retries",
			result: "retry",
		});
		expect(store.routerHistory("do")).toMatchObject([
			{ sessionId: "session-1", tier: "frugal" },
			{ sessionId: "session-2", tier: "standard" },
		]);

		store.close();
	});

	it("does not record router decisions for non-routed skills", () => {
		const store = openTempStore();

		expect(() =>
			recordRouteDecision(store, {
				sessionId: "session-review",
				skill: "review",
			}),
		).toThrow("PAL Router is only enabled for /do");
		expect(store.routerHistory("do")).toEqual([]);

		store.close();
	});
});

function decision(overrides: Partial<RouterDecision> = {}): RouterDecision {
	return {
		id: 1,
		sessionId: "session",
		ts: 0,
		skill: "do",
		tier: "frugal",
		reason: null,
		result: null,
		...overrides,
	};
}

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-router-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
