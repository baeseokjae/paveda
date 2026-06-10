import { describe, expect, it } from "vitest";
import { runConformance } from "../src/conformance/index.js";

describe("conformance runner", () => {
	it("runs Codex deep conformance fixtures in isolated projects", () => {
		const result = runConformance({
			host: "codex",
			profile: "strict",
			now: 10_000,
		});

		expect(result).toMatchObject({
			ok: true,
			host: "codex",
			mode: "isolated-fixture",
			fixtureRoot: null,
		});
		expect(result.fixtures.map((fixture) => fixture.id)).toEqual([
			"code-change-without-tests-blocks",
			"docs-only-not-applicable",
			"codex-goal-lifecycle-handoff",
			"codex-native-goal-status-mapping",
			"projection-drift-blocks",
			"release-not-supported",
		]);
		expect(result.fixtures.map((fixture) => fixture.status)).toEqual([
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
			"pass",
		]);
	});

	it("runs Claude Code deep conformance fixtures in isolated projects", () => {
		const result = runConformance({
			host: "claude-code",
			profile: "strict",
			now: 20_000,
		});

		expect(result.ok).toBe(true);
		expect(result.fixtures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "claude-hook-lifecycle-capture",
					status: "pass",
				}),
				expect.objectContaining({
					id: "claude-bash-command-evidence",
					status: "pass",
				}),
			]),
		);
	});

	it("does not accept harness as a host declaration conformance target", () => {
		expect(() => runConformance({ host: "harness" })).toThrow(
			"Conformance host must be claude-code, codex, pi, or hermes",
		);
	});
});
