import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPavedaClaudeCodeSettings,
	addPavedaEnv,
	addPavedaHooks,
	installClaudeCode,
	summarizeClaudeCodeInstall,
} from "../src/install/claude-code.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Claude Code installer", () => {
	it("adds paveda hook commands to all supported Claude Code hook events", () => {
		expect(addPavedaHooks({})).toEqual({
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "paveda hook claude-code" }] }],
				PreToolUse: [
					{ matcher: "*", hooks: [{ type: "command", command: "paveda hook claude-code" }] },
				],
				PostToolUse: [
					{ matcher: "*", hooks: [{ type: "command", command: "paveda hook claude-code" }] },
				],
				Stop: [{ hooks: [{ type: "command", command: "paveda hook claude-code" }] }],
			},
		});
	});

	it("preserves existing settings and avoids duplicate paveda commands", () => {
		const settings = addPavedaHooks({
			model: "opus",
			hooks: {
				PreToolUse: [
					{
						matcher: "*",
						hooks: [
							{ type: "command", command: "existing-hook" },
							{ type: "command", command: "paveda hook claude-code" },
						],
					},
				],
			},
		});

		expect(settings.model).toBe("opus");
		expect(settings.hooks?.PreToolUse).toEqual([
			{
				matcher: "*",
				hooks: [
					{ type: "command", command: "existing-hook" },
					{ type: "command", command: "paveda hook claude-code" },
				],
			},
		]);
	});

	it("replaces legacy paveda hook wrapper commands", () => {
		const settings = addPavedaClaudeCodeSettings(
			{
				hooks: {
					PreToolUse: [
						{
							matcher: "*",
							hooks: [
								{ type: "command", command: "existing-hook" },
								{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/paveda-hook.sh" },
							],
						},
					],
				},
			},
			{ cliPath: "/opt/paveda/dist/cli.js" },
		);

		expect(settings.hooks?.PreToolUse).toEqual([
			{
				matcher: "*",
				hooks: [
					{ type: "command", command: "existing-hook" },
					{ type: "command", command: "node /opt/paveda/dist/cli.js hook claude-code" },
				],
			},
		]);
	});

	it("writes merged settings when requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-"));
		tempDirs.push(dir);
		const path = join(dir, ".claude", "settings.json");

		const result = installClaudeCode({ path, write: true });
		const written = JSON.parse(readFileSync(path, "utf8")) as unknown;

		expect(result.written).toBe(true);
		expect(result.changed).toBe(true);
		expect(result.summary).toMatchObject({
			command: "paveda hook claude-code",
			env: {
				profile: "standard",
				sessionStartMaxChars: "8000",
			},
		});
		expect(result.summary.hooks).toEqual([
			{ event: "SessionStart", installed: true, commandCount: 1 },
			{ event: "PreToolUse", matcher: "*", installed: true, commandCount: 1 },
			{ event: "PostToolUse", matcher: "*", installed: true, commandCount: 1 },
			{ event: "Stop", installed: true, commandCount: 1 },
		]);
		expect(written).toEqual(result.settings);
	});

	it("refuses to write through a symlinked settings file", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-settings-symlink-"));
		tempDirs.push(dir);
		const claudeDir = join(dir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const externalPath = join(dir, "external-settings.json");
		const linkedPath = join(claudeDir, "settings.json");
		writeFileSync(externalPath, "{}\n");
		symlinkSync(externalPath, linkedPath);

		expect(() => installClaudeCode({ path: linkedPath, write: true })).toThrow(
			"Claude Code settings path must not use symlinks",
		);
		expect(readFileSync(externalPath, "utf8")).toBe("{}\n");
	});

	it("refuses to read through a symlinked settings file during dry-run", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-settings-dry-run-symlink-"));
		tempDirs.push(dir);
		const claudeDir = join(dir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		const externalPath = join(dir, "external-settings.json");
		const linkedPath = join(claudeDir, "settings.json");
		writeFileSync(externalPath, '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
		symlinkSync(externalPath, linkedPath);

		expect(() => installClaudeCode({ path: linkedPath })).toThrow(
			"Claude Code settings path must not use symlinks",
		);
		expect(readFileSync(externalPath, "utf8")).toBe('{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
	});

	it("refuses to write below a symlinked settings directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-settings-dir-symlink-"));
		tempDirs.push(dir);
		const realClaudeDir = join(dir, "real-claude");
		const linkedClaudeDir = join(dir, ".claude");
		mkdirSync(realClaudeDir);
		symlinkSync(realClaudeDir, linkedClaudeDir);

		expect(() =>
			installClaudeCode({ path: join(linkedClaudeDir, "settings.json"), write: true }),
		).toThrow("Claude Code settings path must not use symlinks");
	});

	it("reports unchanged installs when paveda settings already match", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-unchanged-"));
		tempDirs.push(dir);
		const path = join(dir, ".claude", "settings.json");

		installClaudeCode({ path, write: true });
		const result = installClaudeCode({ path });

		expect(result.written).toBe(false);
		expect(result.changed).toBe(false);
		expect(result.summary.hooks.every((hook) => hook.installed)).toBe(true);
	});

	it("adds default paveda environment without overwriting unrelated env", () => {
		expect(addPavedaEnv({ env: { EXISTING: "1" } })).toEqual({
			env: {
				EXISTING: "1",
				PAVEDA_HOOK_PROFILE: "standard",
				PAVEDA_SESSION_START_MAX_CHARS: "8000",
			},
		});
	});

	it("allows installer options to set paveda environment", () => {
		const settings = addPavedaClaudeCodeSettings(
			{
				env: {
					PAVEDA_HOOK_PROFILE: "minimal",
					PAVEDA_SESSION_START_MAX_CHARS: "4000",
				},
			},
			{
				cliPath: "/opt/paveda/dist/cli.js",
				profile: "strict",
				disabledHooks: "tool.execute.before:Bash:harness.tooling.enforce",
				projectHooks: true,
				sessionStartContext: false,
				sessionStartMaxChars: 12000,
			},
		);

		expect(settings.env).toEqual({
			PAVEDA_CLI: "/opt/paveda/dist/cli.js",
			PAVEDA_HOOK_PROFILE: "strict",
			PAVEDA_SESSION_START_MAX_CHARS: "12000",
			PAVEDA_DISABLED_HOOKS: "tool.execute.before:Bash:harness.tooling.enforce",
			PAVEDA_PROJECT_HOOKS: "on",
			PAVEDA_SESSION_START_CONTEXT: "off",
		});
		expect(settings.hooks?.SessionStart).toEqual([
			{ hooks: [{ type: "command", command: "node /opt/paveda/dist/cli.js hook claude-code" }] },
		]);
	});

	it("quotes cli paths with shell-sensitive characters", () => {
		const settings = addPavedaClaudeCodeSettings(
			{},
			{ cliPath: "/opt/open source/paveda/dist/cli.js" },
		);

		expect(settings.hooks?.SessionStart).toEqual([
			{
				hooks: [
					{
						type: "command",
						command: "node '/opt/open source/paveda/dist/cli.js' hook claude-code",
					},
				],
			},
		]);
	});

	it("summarizes installed hooks and paveda env", () => {
		const settings = addPavedaClaudeCodeSettings(
			{},
			{
				cliPath: "/opt/paveda/dist/cli.js",
				profile: "strict",
				disabledHooks: "tool.execute.before:Bash:harness.tooling.enforce",
				projectHooks: true,
				sessionStartContext: false,
				sessionStartMaxChars: 12000,
			},
		);

		expect(
			summarizeClaudeCodeInstall(settings, "node /opt/paveda/dist/cli.js hook claude-code"),
		).toEqual({
			command: "node /opt/paveda/dist/cli.js hook claude-code",
			hooks: [
				{ event: "SessionStart", installed: true, commandCount: 1 },
				{ event: "PreToolUse", matcher: "*", installed: true, commandCount: 1 },
				{ event: "PostToolUse", matcher: "*", installed: true, commandCount: 1 },
				{ event: "Stop", installed: true, commandCount: 1 },
			],
			env: {
				cliPath: "/opt/paveda/dist/cli.js",
				profile: "strict",
				sessionStartMaxChars: "12000",
				disabledHooks: "tool.execute.before:Bash:harness.tooling.enforce",
				projectHooks: "on",
				sessionStartContext: "off",
			},
		});
	});
});
