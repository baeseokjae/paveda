import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPavedaCodexHooks,
	installCodex,
	renderCodexRequirementsToml,
	summarizeCodexInstall,
} from "../src/install/codex.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Codex installer", () => {
	it("adds paveda hooks to supported Codex lifecycle events", () => {
		const config = addPavedaCodexHooks({});

		expect(config.hooks?.SessionStart).toEqual([
			{
				matcher: "startup|resume|clear|compact",
				hooks: [
					{
						type: "command",
						command: "paveda hook codex",
						timeout: 30,
						statusMessage: "Loading Paveda session policy",
					},
				],
			},
		]);
		expect(config.hooks?.PreToolUse).toEqual([
			expect.objectContaining({ matcher: "Bash" }),
			expect.objectContaining({ matcher: "apply_patch|Edit|Write" }),
			expect.objectContaining({ matcher: "mcp__.*" }),
		]);
		expect(config.hooks?.PermissionRequest).toEqual([
			expect.objectContaining({ matcher: "Bash|apply_patch|Edit|Write|mcp__.*" }),
		]);
		expect(config.hooks?.UserPromptSubmit).toEqual([
			expect.objectContaining({
				hooks: [expect.objectContaining({ command: "paveda hook codex" })],
			}),
		]);
	});

	it("preserves existing hooks and replaces legacy Paveda Codex commands", () => {
		const config = addPavedaCodexHooks(
			{
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [
								{ type: "command", command: "existing-hook" },
								{ type: "command", command: "paveda hook codex" },
							],
						},
					],
				},
			},
			"node /opt/paveda/dist/cli.js hook codex",
		);

		expect(config.hooks?.PreToolUse?.[0]).toEqual({
			matcher: "Bash",
			hooks: [
				{ type: "command", command: "existing-hook" },
				{
					type: "command",
					command: "node /opt/paveda/dist/cli.js hook codex",
					timeout: 30,
					statusMessage: "Checking Paveda Bash policy",
				},
			],
		});
	});

	it("writes hooks config and managed requirements when requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-codex-"));
		tempDirs.push(dir);
		const hooksPath = join(dir, ".codex", "hooks.json");
		const requirementsPath = join(dir, "requirements.toml");

		const result = installCodex({
			path: hooksPath,
			requirementsPath,
			managed: true,
			write: true,
		});

		expect(result.written).toBe(true);
		expect(result.changed).toBe(true);
		expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(result.hooksConfig);
		expect(readFileSync(requirementsPath, "utf8")).toContain("allow_managed_hooks_only = true");
		expect(result.summary).toMatchObject({
			command: "paveda hook codex",
			managed: true,
			requirementsPath,
			allowManagedHooksOnly: true,
			managedDir: ".codex/hooks",
		});
		expect(result.summary.hooks.every((hook) => hook.installed)).toBe(true);
	});

	it("renders managed requirements with feature pinning, managed hook directory, and command rules", () => {
		expect(
			renderCodexRequirementsToml({
				command: "node /opt/paveda/dist/cli.js hook codex",
				managedDir: "/etc/codex/hooks",
				allowManagedHooksOnly: false,
			}),
		).toContain('[features]\nhooks = true\n\n[hooks]\nmanaged_dir = "/etc/codex/hooks"');
		expect(
			renderCodexRequirementsToml({
				command: "node /opt/paveda/dist/cli.js hook codex",
			}),
		).toContain("[[rules.prefix_rules]]");
	});

	it("refuses to append managed requirements to existing files unless forced", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-codex-existing-"));
		tempDirs.push(dir);
		const requirementsPath = join(dir, "requirements.toml");
		writeFileSync(requirementsPath, "[features]\nnetwork_proxy = false\n");

		expect(() => installCodex({ requirementsPath, managed: true })).toThrow(
			"Codex requirements file already exists without a Paveda managed block",
		);

		const result = installCodex({ requirementsPath, managed: true, force: true });

		expect(result.requirementsToml).toContain("[features]\nnetwork_proxy = false");
		expect(result.requirementsToml).toContain("BEGIN PAVEDA MANAGED CODEX POLICY");
	});

	it("refuses to read or write through symlinked paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-codex-symlink-"));
		tempDirs.push(dir);
		const codexDir = join(dir, ".codex");
		mkdirSync(codexDir, { recursive: true });
		const externalHooks = join(dir, "external-hooks.json");
		const linkedHooks = join(codexDir, "hooks.json");
		writeFileSync(externalHooks, "{}\n");
		symlinkSync(externalHooks, linkedHooks);

		expect(() => installCodex({ path: linkedHooks, write: true })).toThrow(
			"Codex hooks path must not use symlinks",
		);
		expect(readFileSync(externalHooks, "utf8")).toBe("{}\n");
	});

	it("summarizes installed Codex hooks", () => {
		const config = addPavedaCodexHooks({});

		expect(summarizeCodexInstall(config)).toMatchObject({
			command: "paveda hook codex",
			managed: false,
			hooks: [
				{ event: "SessionStart", matcher: "startup|resume|clear|compact", installed: true },
				{ event: "UserPromptSubmit", installed: true },
				{ event: "PreToolUse", matcher: "Bash", installed: true },
				{ event: "PreToolUse", matcher: "apply_patch|Edit|Write", installed: true },
				{ event: "PreToolUse", matcher: "mcp__.*", installed: true },
				{
					event: "PermissionRequest",
					matcher: "Bash|apply_patch|Edit|Write|mcp__.*",
					installed: true,
				},
				{
					event: "PostToolUse",
					matcher: "Bash|apply_patch|Edit|Write|mcp__.*",
					installed: true,
				},
				{ event: "Stop", installed: true },
			],
		});
	});
});
