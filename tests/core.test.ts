import { describe, expect, it } from "vitest";
import { loadConfig, parseDisabledHooks } from "../src/core/index.js";

describe("core config", () => {
	it("validates hook profile values", () => {
		expect(loadConfig({}).hookProfile).toBe("standard");
		expect(loadConfig({ PAVEDA_HOOK_PROFILE: "minimal" }).hookProfile).toBe("minimal");
		expect(loadConfig({ PAVEDA_HOOK_PROFILE: "standard" }).hookProfile).toBe("standard");
		expect(loadConfig({ PAVEDA_HOOK_PROFILE: "strict" }).hookProfile).toBe("strict");
		expect(() => loadConfig({ PAVEDA_HOOK_PROFILE: "fast" })).toThrow(
			"Invalid PAVEDA_HOOK_PROFILE",
		);
	});

	it("uses standard cost guard defaults unless strict profile is selected", () => {
		expect(loadConfig({}).costGuardMaxMinutes).toBe(120);
		expect(loadConfig({}).costGuardAgentWarningThreshold).toBe(5);
		expect(loadConfig({}).costGuardAgentCompactInterval).toBe(3);
		expect(loadConfig({}).projectHooks).toBe(false);

		const strict = loadConfig({ PAVEDA_HOOK_PROFILE: "strict" });

		expect(strict.costGuardMaxMinutes).toBe(60);
		expect(strict.costGuardAgentWarningThreshold).toBe(3);
		expect(strict.costGuardAgentCompactInterval).toBe(2);
	});

	it("keeps explicit cost guard env values authoritative in strict profile", () => {
		expect(
			loadConfig({
				PAVEDA_HOOK_PROFILE: "strict",
				PAVEDA_COST_GUARD_MAX_MINUTES: "90",
				PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD: "7",
				PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL: "4",
			}),
		).toMatchObject({
			costGuardMaxMinutes: 90,
			costGuardAgentWarningThreshold: 7,
			costGuardAgentCompactInterval: 4,
		});
	});

	it("rejects invalid positive integer environment values", () => {
		expect(() => loadConfig({ PAVEDA_SESSION_START_MAX_CHARS: "0" })).toThrow(
			"Invalid PAVEDA_SESSION_START_MAX_CHARS",
		);
		expect(() => loadConfig({ PAVEDA_COST_GUARD_MAX_MINUTES: "-1" })).toThrow(
			"Invalid PAVEDA_COST_GUARD_MAX_MINUTES",
		);
		expect(() => loadConfig({ PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD: "1.5" })).toThrow(
			"Invalid PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD",
		);
		expect(() => loadConfig({ PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL: "later" })).toThrow(
			"Invalid PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL",
		);
	});

	it("parses disabled hook selectors and rejects malformed selectors", () => {
		expect(
			parseDisabledHooks(
				"tool.execute.before:Bash:harness.destructive.guard,tool.execute.after:*:*",
			),
		).toEqual([
			{
				lifecycle: "tool.execute.before",
				matcher: "Bash",
				name: "harness.destructive.guard",
			},
			{ lifecycle: "tool.execute.after", matcher: "*", name: "*" },
		]);
		expect(parseDisabledHooks("")).toEqual([]);
		expect(() => parseDisabledHooks("tool.execute.before:Bash")).toThrow(
			"Invalid disabled hook selector",
		);
		expect(() => parseDisabledHooks("tool.execute.before::harness.destructive.guard")).toThrow(
			"Invalid disabled hook selector",
		);
	});

	it("requires explicit opt-in for project-owned hooks", () => {
		expect(loadConfig({ PAVEDA_PROJECT_HOOKS: "on" }).projectHooks).toBe(true);
		expect(loadConfig({ PAVEDA_PROJECT_HOOKS: "true" }).projectHooks).toBe(true);
		expect(loadConfig({ PAVEDA_PROJECT_HOOKS: "1" }).projectHooks).toBe(true);
		expect(loadConfig({ PAVEDA_PROJECT_HOOKS: "off" }).projectHooks).toBe(false);
		expect(() => loadConfig({ PAVEDA_PROJECT_HOOKS: "yes" })).toThrow(
			"Invalid PAVEDA_PROJECT_HOOKS",
		);
	});

	it("allows SessionStart context injection to be disabled", () => {
		expect(loadConfig({}).sessionStartContext).toBe(true);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "off" }).sessionStartContext).toBe(false);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "false" }).sessionStartContext).toBe(false);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "0" }).sessionStartContext).toBe(false);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "on" }).sessionStartContext).toBe(true);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "true" }).sessionStartContext).toBe(true);
		expect(loadConfig({ PAVEDA_SESSION_START_CONTEXT: "1" }).sessionStartContext).toBe(true);
		expect(() => loadConfig({ PAVEDA_SESSION_START_CONTEXT: "maybe" })).toThrow(
			"Invalid PAVEDA_SESSION_START_CONTEXT",
		);
	});
});
