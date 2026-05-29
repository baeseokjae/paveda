import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorResult } from "../src/doctor/index.js";
import type { HostSkillBundleTarget } from "../src/host-bundles/index.js";
import { initializePaveda } from "../src/init/index.js";

const tempDirs: string[] = [];
const HOST_INIT_MATRIX: Array<{
	host: HostSkillBundleTarget;
	skillRoot: string;
	contextRoot: string;
	instructionFile: string;
}> = [
	{
		host: "harness",
		skillRoot: ".harness/skills",
		contextRoot: ".harness/context-modules",
		instructionFile: ".harness/AGENTS.md",
	},
	{
		host: "claude-code",
		skillRoot: ".claude/skills",
		contextRoot: ".claude/context-modules",
		instructionFile: ".claude/CLAUDE.md",
	},
	{
		host: "codex",
		skillRoot: ".codex/skills",
		contextRoot: ".codex/context-modules",
		instructionFile: "AGENTS.md",
	},
	{
		host: "pi",
		skillRoot: ".pi/skills",
		contextRoot: ".pi/context-modules",
		instructionFile: ".pi/AGENTS.md",
	},
	{
		host: "hermes",
		skillRoot: ".hermes/skills",
		contextRoot: ".hermes/context-modules",
		instructionFile: ".hermes/AGENTS.md",
	},
];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("init", () => {
	it.each(HOST_INIT_MATRIX)("writes packaged harness init output for $host", (hostCase) => {
		const dir = mkdtempSync(join(tmpdir(), `paveda-init-${hostCase.host}-`));
		tempDirs.push(dir);
		const manifest = readPackagedHarnessManifest();
		const skillNames = manifest.skills.map((skill) => skill.name);
		const contextModuleNames = manifest.contextModules.map((module) => basename(module.path));

		const result = initializePaveda({
			host: hostCase.host,
			cwd: dir,
			cliPath: "/opt/paveda/dist/cli.js",
			write: true,
		});

		expect(result).toMatchObject({
			cwd: dir,
			host: hostCase.host,
			written: true,
			force: false,
			bundle: {
				host: hostCase.host,
				targetRoot: joinPath(dir, hostCase.skillRoot),
				written: true,
			},
		});
		expect(result.nextCommands.map((command) => command.name)).toEqual([
			"doctor",
			"skills-status",
			"route-do",
			"runtime-smoke",
		]);
		expect(result.nextCommands.find((command) => command.name === "doctor")?.command).toContain(
			`doctor --host ${hostCase.host}`,
		);
		expect(
			result.nextCommands.find((command) => command.name === "runtime-smoke")?.command,
		).toContain("runtime-smoke");
		expect(result.bundle.skills.map((skill) => skill.name)).toEqual(skillNames);
		expect(result.bundle.contextModules.map((module) => module.name)).toEqual(contextModuleNames);
		expect(result.bundle.instructionFile?.targetPath).toBe(joinPath(dir, hostCase.instructionFile));
		expect(result.doctor.ok).toBe(true);
		expect(check(result.doctor, "host-skill-root")?.status).toBe("pass");
		expect(check(result.doctor, "host-instruction-file")?.status).toBe("pass");
		expect(check(result.doctor, "host-context-modules")?.status).toBe("pass");
		expect(check(result.doctor, "host-rendered-paths")?.status).toBe("pass");
		expect(check(result.doctor, "do-skill")?.status).toBe("pass");
		expect(check(result.doctor, "do-router")?.status).toBe("pass");
		expect(check(result.doctor, "claude-code-hooks")?.status).toBe(
			hostCase.host === "claude-code" ? "pass" : "warn",
		);
		expect(check(result.doctor, "host-codex-metadata")?.status).toBe(
			hostCase.host === "codex" ? "pass" : undefined,
		);

		const instruction = readFileSync(joinPath(dir, hostCase.instructionFile), "utf8");
		expect(instruction).toContain(`- Workflow skills: \`${hostCase.skillRoot}\``);
		expect(instruction).toContain("- Project hooks: `.harness/hooks`");
		expect(instruction).toContain("- Project checks: `.harness/checks`");
		expect(instruction).toContain(`- Context modules: \`${hostCase.contextRoot}\``);
		expect(instruction).toContain(`- Harness instructions: \`${hostCase.instructionFile}\``);

		for (const moduleName of contextModuleNames) {
			expect(existsSync(joinPath(dir, hostCase.contextRoot, moduleName))).toBe(true);
		}

		for (const skillName of skillNames) {
			const skillPath = joinPath(dir, hostCase.skillRoot, skillName, "SKILL.md");
			expect(existsSync(skillPath)).toBe(true);
			const skillText = readFileSync(skillPath, "utf8");
			expect(skillText).toContain(`name: ${skillName}`);
			expect(
				existsSync(joinPath(dir, hostCase.skillRoot, skillName, "agents", "openai.yaml")),
			).toBe(hostCase.host === "codex");
		}

		const doSkill = readFileSync(joinPath(dir, hostCase.skillRoot, "do", "SKILL.md"), "utf8");
		expect(doSkill).toContain("router: enabled");
		expect(doSkill).toContain(`${hostCase.skillRoot}/do/scripts/detect-stagnation.sh`);
		expect(doSkill).toContain(`\`${hostCase.contextRoot}/backend-patterns.md\``);
		if (hostCase.host !== "harness") {
			expect(doSkill).not.toContain(".harness/skills");
			expect(doSkill).not.toContain(".harness/context-modules");
			expect(doSkill).not.toContain(".harness/AGENTS.md");
		}
	});

	it("dry-runs host bundle initialization without writing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-dry-run-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);

		const result = initializePaveda({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			skills: ["do"],
		});

		expect(result).toMatchObject({
			cwd: dir,
			host: "codex",
			written: false,
			force: false,
			bundle: {
				written: false,
				targetRoot: join(dir, ".codex", "skills"),
			},
		});
		expect(result.nextCommands.map((command) => command.name)).toEqual([
			"write-init",
			"doctor",
			"skills-status",
			"route-do",
			"runtime-smoke",
		]);
		expect(result.nextCommands[0]?.command).toContain("init --host codex");
		expect(result.nextCommands[0]?.command).toContain("--skills do");
		expect(result.nextCommands[0]?.command).toContain("--write");
		expect(result.doctor.ok).toBe(false);
		expect(existsSync(join(dir, ".codex", "skills", "do", "SKILL.md"))).toBe(false);
		expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
	});

	it("writes a host bundle and returns a passing doctor result", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-codex-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);

		const result = initializePaveda({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			skills: ["do"],
			write: true,
		});

		expect(result.written).toBe(true);
		expect(result.doctor.ok).toBe(true);
		expect(readFileSync(join(dir, ".codex", "skills", "do", "SKILL.md"), "utf8")).toContain(
			"router: enabled",
		);
		expect(
			readFileSync(join(dir, ".codex", "context-modules", "backend-patterns.md"), "utf8"),
		).toBe("# Backend patterns\n");
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("`.codex/skills`");
	});

	it("initializes host bundles into a custom target root and carries it through next commands", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-custom-root-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);

		const result = initializePaveda({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot: "vendor/codex-skills",
			skills: ["do"],
			write: true,
		});

		expect(result.bundle.targetRoot).toBe(join(dir, "vendor", "codex-skills"));
		expect(result.doctor.ok).toBe(true);
		expect(check(result.doctor, "host-skill-root")).toMatchObject({
			status: "pass",
			path: join(dir, "vendor", "codex-skills"),
		});
		expect(existsSync(join(dir, "vendor", "codex-skills", "do", "SKILL.md"))).toBe(true);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("`vendor/codex-skills`");
		expect(result.nextCommands.find((command) => command.name === "doctor")?.command).toContain(
			"--target-root vendor/codex-skills",
		);
		expect(
			result.nextCommands.find((command) => command.name === "skills-status")?.command,
		).toContain("--target-root vendor/codex-skills");
		expect(result.nextCommands.find((command) => command.name === "route-do")?.command).toContain(
			"--target-root vendor/codex-skills",
		);
	});

	it("writes Claude Code hooks when the host is claude-code", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-claude-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);

		const result = initializePaveda({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			skills: ["do"],
			cliPath: "/opt/paveda/dist/cli.js",
			profile: "strict",
			projectHooks: true,
			sessionStartContext: false,
			sessionStartMaxChars: 4000,
			write: true,
		});

		expect(result.claudeCode).toBeDefined();
		expect(result.doctor.ok).toBe(true);
		const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")) as {
			env?: Record<string, string>;
			hooks?: Record<string, unknown>;
		};
		expect(settings.env).toMatchObject({
			PAVEDA_CLI: "/opt/paveda/dist/cli.js",
			PAVEDA_HOOK_PROFILE: "strict",
			PAVEDA_PROJECT_HOOKS: "on",
			PAVEDA_SESSION_START_CONTEXT: "off",
			PAVEDA_SESSION_START_MAX_CHARS: "4000",
		});
		expect(
			result.nextCommands.every((command) =>
				command.command.startsWith("node /opt/paveda/dist/cli.js"),
			),
		).toBe(true);
		expect(readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8")).toContain("`.claude/skills`");
	});

	it("preflights Claude Code settings before writing host bundle files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-claude-settings-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);
		const externalSettings = join(dir, "external-settings.json");
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(externalSettings, "{}\n");
		symlinkSync(externalSettings, join(dir, ".claude", "settings.json"));

		expect(() =>
			initializePaveda({
				host: "claude-code",
				cwd: dir,
				builtinRoots: [builtinRoot],
				skills: ["do"],
				write: true,
				force: true,
			}),
		).toThrow("Claude Code settings path must not use symlinks");
		expect(readFileSync(externalSettings, "utf8")).toBe("{}\n");
		expect(existsSync(join(dir, ".claude", "skills", "do", "SKILL.md"))).toBe(false);
		expect(existsSync(join(dir, ".claude", "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(dir, ".claude", "context-modules", "backend-patterns.md"))).toBe(false);
	});

	it("preflights Claude Code settings before dry-run output", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-init-claude-dry-run-settings-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);
		const externalSettings = join(dir, "external-settings.json");
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(externalSettings, '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
		symlinkSync(externalSettings, join(dir, ".claude", "settings.json"));

		expect(() =>
			initializePaveda({
				host: "claude-code",
				cwd: dir,
				builtinRoots: [builtinRoot],
				skills: ["do"],
			}),
		).toThrow("Claude Code settings path must not use symlinks");
		expect(readFileSync(externalSettings, "utf8")).toBe(
			'{"env":{"PRIVATE_VALUE":"do-not-print"}}\n',
		);
		expect(existsSync(join(dir, ".claude", "skills", "do", "SKILL.md"))).toBe(false);
		expect(existsSync(join(dir, ".claude", "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(dir, ".claude", "context-modules", "backend-patterns.md"))).toBe(false);
	});

	it("quotes next-command paths with spaces", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda init space path-"));
		tempDirs.push(dir);
		const builtinRoot = writeHarnessFixture(dir);

		const result = initializePaveda({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			cliPath: "/opt/open source/paveda/dist/cli.js",
			profile: "strict",
			disabledHooks: "tool.execute.before:Bash:harness.destructive.guard",
			projectHooks: true,
			sessionStartContext: false,
			sessionStartMaxChars: 4000,
		});

		expect(result.nextCommands[0]?.command).toContain("node '/opt/open source/paveda/dist/cli.js'");
		expect(result.nextCommands[0]?.command).toContain(`--cwd '${dir}'`);
		expect(result.nextCommands[0]?.command).toContain(
			"--cli-path '/opt/open source/paveda/dist/cli.js'",
		);
		expect(result.nextCommands[0]?.command).toContain("--profile strict");
		expect(result.nextCommands[0]?.command).toContain(
			"--disabled-hooks tool.execute.before:Bash:harness.destructive.guard",
		);
		expect(result.nextCommands[0]?.command).toContain("--project-hooks");
		expect(result.nextCommands[0]?.command).toContain("--session-start-context off");
		expect(result.nextCommands[0]?.command).toContain("--session-start-max-chars 4000");
		expect(check(result.doctor, "host-skill-root")?.recovery?.command).toContain(
			`node '/opt/open source/paveda/dist/cli.js' skills install-bundle --host codex --cwd '${dir}' --write`,
		);
	});
});

function check(result: DoctorResult, name: string) {
	return result.checks.find((item) => item.name === name);
}

function joinPath(root: string, path: string, ...parts: string[]): string {
	return join(root, ...path.split("/"), ...parts);
}

function readPackagedHarnessManifest(): {
	contextModules: Array<{ path: string }>;
	skills: Array<{ name: string }>;
} {
	return JSON.parse(
		readFileSync(join(process.cwd(), "assets", "harness", "manifest.json"), "utf8"),
	);
}

function writeHarnessFixture(dir: string): string {
	const harnessRoot = join(dir, "builtin");
	const skillsRoot = join(harnessRoot, "skills");
	mkdirSync(join(skillsRoot, "do"), { recursive: true });
	writeFileSync(
		join(skillsRoot, "do", "SKILL.md"),
		`---
name: do
description: do skill
router: enabled
ambiguity-required: 0.2
---

# do
`,
	);
	writeFileSync(
		join(harnessRoot, "AGENTS.md"),
		[
			"# Instructions",
			"",
			"- Workflow skills: `.harness/skills`",
			"- Project hooks: `.harness/hooks`",
			"- Harness instructions: `.harness/AGENTS.md`",
			"",
		].join("\n"),
	);
	const contextRoot = join(harnessRoot, "context-modules");
	mkdirSync(contextRoot, { recursive: true });
	writeFileSync(join(contextRoot, "backend-patterns.md"), "# Backend patterns\n");
	writeFileSync(join(contextRoot, "frontend-patterns.md"), "# Frontend patterns\n");
	writeFileSync(join(contextRoot, "worker-patterns.md"), "# Worker patterns\n");
	writeFileSync(join(contextRoot, "infra-patterns.md"), "# Infrastructure patterns\n");
	return skillsRoot;
}
