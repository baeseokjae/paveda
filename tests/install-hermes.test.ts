import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addPavedaHermesHooks,
	installHermes,
	renderHermesHookScript,
	summarizeHermesInstall,
} from "../src/install/hermes.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Hermes installer", () => {
	it("adds Paveda shell hooks to Hermes config", () => {
		const config = addPavedaHermesHooks("", {
			command: ".hermes/agent-hooks/paveda-policy.sh",
			hooksAutoAccept: true,
		});

		expect(config).toContain("hooks:\n  on_session_start:");
		expect(config).toContain(
			'matcher: "terminal|bash|shell|write_file|write|edit_file|edit|patch"',
		);
		expect(config).toContain("command: .hermes/agent-hooks/paveda-policy.sh");
		expect(config).toContain("hooks_auto_accept: true");
		expect(summarizeHermesInstall(config).hooks.every((hook) => hook.installed)).toBe(true);
	});

	it("preserves existing config and avoids duplicate Paveda hook entries", () => {
		const first = addPavedaHermesHooks(
			[
				"model:",
				"  default: gpt-5.4",
				"",
				"hooks:",
				"  pre_tool_call:",
				"    - matcher: terminal",
				"      command: existing-hook",
				"",
			].join("\n"),
			{ command: ".hermes/agent-hooks/paveda-policy.sh" },
		);
		const second = addPavedaHermesHooks(first, {
			command: ".hermes/agent-hooks/paveda-policy.sh",
		});

		expect(second).toContain("model:\n  default: gpt-5.4");
		expect(second).toContain("command: existing-hook");
		expect(second.match(/paveda-policy\.sh/g)).toHaveLength(7);
	});

	it("writes Hermes config and executable hook script when requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-hermes-"));
		tempDirs.push(dir);
		const configPath = join(dir, ".hermes", "config.yaml");
		const hookPath = join(dir, ".hermes", "agent-hooks", "paveda-policy.sh");

		const result = installHermes({
			configPath,
			hookPath,
			command: "node /opt/paveda/dist/cli.js hook hermes",
			hooksAutoAccept: true,
			write: true,
		});

		expect(result.written).toBe(true);
		expect(result.changed).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(result.configYaml);
		expect(readFileSync(hookPath, "utf8")).toBe(result.hookScript);
		expect(statSync(hookPath).mode & 0o111).toBeGreaterThan(0);
		expect(result.summary).toMatchObject({
			runtimeCommand: "node /opt/paveda/dist/cli.js hook hermes",
			hooksAutoAccept: true,
		});
		expect(result.summary.hooks.every((hook) => hook.installed)).toBe(true);
	});

	it("refuses to replace an unmanaged hook script unless forced", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-hermes-existing-"));
		tempDirs.push(dir);
		const hookPath = join(dir, ".hermes", "agent-hooks", "paveda-policy.sh");
		mkdirSync(join(dir, ".hermes", "agent-hooks"), { recursive: true });
		writeFileSync(hookPath, "#!/usr/bin/env bash\necho unmanaged\n");

		expect(() => installHermes({ hookPath, write: true })).toThrow(
			"Hermes hook script already exists without a Paveda managed block",
		);

		const result = installHermes({ hookPath, force: true, write: true });

		expect(readFileSync(hookPath, "utf8")).toBe(result.hookScript);
	});

	it("refuses to read or write through symlinked paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-hermes-symlink-"));
		tempDirs.push(dir);
		const external = join(dir, "external-config.yaml");
		const linked = join(dir, ".hermes", "config.yaml");
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(external, "hooks: {}\n");
		symlinkSync(external, linked);

		expect(() => installHermes({ configPath: linked, write: true })).toThrow(
			"Hermes config path must not use symlinks",
		);
		expect(existsSync(external)).toBe(true);
	});

	it("renders managed Hermes hook script", () => {
		expect(renderHermesHookScript("paveda hook hermes")).toContain("exec paveda hook hermes");
		expect(renderHermesHookScript()).toContain("BEGIN PAVEDA MANAGED HERMES POLICY");
	});
});
