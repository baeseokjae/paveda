import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveEnforcementFailedProbes,
	resolveEnforcementProbeStatus,
} from "../src/doctor/enforcement.js";
import { formatDoctorReport, runDoctor } from "../src/doctor/index.js";
import { installHostSkillBundle } from "../src/host-bundles/index.js";
import { addPavedaClaudeCodeSettings } from "../src/install/claude-code.js";
import { renderCodexRequirementsToml } from "../src/install/codex.js";
import {
	type PolicyBundle,
	createPolicyBundle,
	createPolicyBundleCacheEntry,
	signPolicyBundle,
	verifySignedPolicyBundleWithKeyring,
} from "../src/policy/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("doctor", () => {
	it("passes for an installed host bundle with routed do skill and instructions", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-host-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const result = runDoctor({ cwd: dir, host: "codex" });

		expect(result.ok).toBe(true);
		expect(check(result, "host-skill-root")?.status).toBe("pass");
		expect(check(result, "host-instruction-file")).toMatchObject({
			status: "pass",
			path: join(dir, "AGENTS.md"),
		});
		expect(check(result, "host-context-modules")).toMatchObject({
			status: "pass",
			path: join(dir, ".codex", "context-modules"),
		});
		expect(check(result, "host-rendered-paths")?.status).toBe("pass");
		expect(check(result, "host-model-metadata")?.status).toBe("pass");
		expect(check(result, "host-codex-metadata")).toMatchObject({
			status: "pass",
			path: join(dir, ".codex", "skills"),
			details: { missing: [] },
		});
		expect(check(result, "do-skill")?.status).toBe("pass");
		expect(check(result, "do-router")?.status).toBe("pass");
		expect(check(result, "claude-code-hooks")?.status).toBe("warn");
	});

	it("fails Codex adoption when skill discovery metadata is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-codex-metadata-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		rmSync(join(dir, ".codex", "skills", "do", "agents", "openai.yaml"), { force: true });

		const result = runDoctor({ cwd: dir, host: "codex" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-codex-metadata")).toMatchObject({
			status: "fail",
			details: { missing: [".codex/skills/do/agents/openai.yaml"] },
		});
	});

	it("fails host adoption when rendered host bundle paths are stale", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-stale-host-paths-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		writeFileSync(
			join(dir, ".codex", "skills", "do", "stale.md"),
			[
				"Bad skill path: `.harness/skills/do/SKILL.md`",
				"Bad hook path: `.codex/hooks/PostToolUse/check.sh`",
				"",
			].join("\n"),
		);

		const result = runDoctor({ cwd: dir, host: "codex" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-rendered-paths")).toMatchObject({
			status: "fail",
			details: {
				issues: expect.arrayContaining([
					".codex/skills/do/stale.md contains .codex/hooks",
					".codex/skills/do/stale.md contains .harness/skills",
				]),
			},
		});
		expect(check(result, "host-rendered-paths")?.recovery).toBeUndefined();
	});

	it("fails Codex adoption when unsupported model frontmatter remains", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-codex-model-metadata-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"router: enabled\nambiguity-required: 0.2\nmodel: standard",
		);
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		writeFileSync(
			join(dir, ".codex", "skills", "do", "agents", "bad.md"),
			"---\nmodel: standard\n---\n# Bad metadata\n",
		);

		const result = runDoctor({ cwd: dir, host: "codex" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-model-metadata")).toMatchObject({
			status: "fail",
			details: {
				issues: [
					".codex/skills/do/agents/bad.md has model: standard (model frontmatter is not supported for codex)",
				],
			},
		});
	});

	it("fails Claude Code adoption when generic model tiers remain", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-claude-model-metadata-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"router: enabled\nambiguity-required: 0.2\nmodel: frontier",
		);
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		writeFileSync(
			join(dir, ".claude", "skills", "do", "bad.md"),
			"---\nmodel: frontier\n---\n# Bad metadata\n",
		);

		const result = runDoctor({ cwd: dir, host: "claude-code" });

		expect(check(result, "host-model-metadata")).toMatchObject({
			status: "fail",
			details: {
				issues: [
					".claude/skills/do/bad.md has model: frontier (generic model tier was not rendered for claude-code)",
				],
			},
		});
	});

	it("fails host adoption when the routed do skill is missing from the host bundle", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-missing-host-"));
		tempDirs.push(dir);

		const result = runDoctor({ cwd: dir, host: "hermes" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-skill-root")?.status).toBe("fail");
		expect(check(result, "host-skill-root")?.recovery?.command).toContain(
			`paveda skills install-bundle --host hermes --cwd ${dir} --write`,
		);
		expect(check(result, "host-instruction-file")?.status).toBe("fail");
		expect(check(result, "host-context-modules")?.status).toBe("fail");
		expect(check(result, "host-codex-metadata")).toBeUndefined();
		expect(check(result, "host-hermes-config")?.status).toBe("fail");
		expect(check(result, "host-hermes-config")?.recovery?.command).toContain("--force");
		expect(check(result, "do-skill")?.status).toBe("fail");
		expect(check(result, "do-router")?.status).toBe("fail");
	});

	it("checks Hermes project skill registration", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-hermes-config-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const result = runDoctor({ cwd: dir, host: "hermes" });

		expect(result.ok).toBe(true);
		expect(check(result, "host-hermes-config")).toMatchObject({
			status: "pass",
			path: join(dir, ".hermes", "config.yaml"),
			details: { requiredEntry: ".hermes/skills" },
		});
	});

	it("checks host bundles installed to a custom target root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-custom-target-root-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot: "vendor/codex-skills",
			write: true,
		});

		const defaultResult = runDoctor({ cwd: dir, host: "codex" });
		const customResult = runDoctor({
			cwd: dir,
			host: "codex",
			targetRoot: "vendor/codex-skills",
		});

		expect(defaultResult.ok).toBe(false);
		expect(customResult.ok).toBe(true);
		expect(customResult.targetRoot).toBe(join(dir, "vendor", "codex-skills"));
		expect(check(customResult, "host-skill-root")).toMatchObject({
			status: "pass",
			path: join(dir, "vendor", "codex-skills"),
		});
		expect(check(customResult, "host-rendered-paths")?.status).toBe("pass");
		expect(check(customResult, "host-codex-metadata")?.status).toBe("pass");
		expect(check(customResult, "do-router")?.status).toBe("pass");
	});

	it("includes custom target roots in host bundle recovery commands", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-custom-target-root-missing-"));
		tempDirs.push(dir);

		const result = runDoctor({ cwd: dir, host: "codex", targetRoot: "vendor/codex-skills" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-skill-root")?.message).toContain(
			"skills install-bundle --host codex --target-root vendor/codex-skills --write",
		);
		expect(check(result, "host-instruction-file")?.message).toContain(
			"skills install-bundle --host codex --target-root vendor/codex-skills --write",
		);
		expect(check(result, "host-context-modules")?.message).toContain(
			"skills install-bundle --host codex --target-root vendor/codex-skills --write",
		);
		expect(check(result, "do-skill")?.message).toContain(
			"skills install-bundle --host codex --target-root vendor/codex-skills --skills do --write",
		);
		expect(check(result, "host-skill-root")?.recovery).toMatchObject({
			command: `paveda skills install-bundle --host codex --cwd ${dir} --target-root vendor/codex-skills --write`,
			description: expect.any(String),
		});
		expect(check(result, "do-skill")?.recovery?.command).toBe(
			`paveda skills install-bundle --host codex --cwd ${dir} --target-root vendor/codex-skills --skills do --write`,
		);
		expect(formatDoctorReport(result)).toContain(
			`targetRoot: ${join(dir, "vendor", "codex-skills")}`,
		);
		expect(formatDoctorReport(result)).toContain(
			`recovery: paveda skills install-bundle --host codex --cwd ${dir} --target-root vendor/codex-skills --write`,
		);
	});

	it("checks Hermes registration for a custom target root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-hermes-custom-target-root-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot: "vendor/hermes-skills",
			write: true,
		});

		const result = runDoctor({ cwd: dir, host: "hermes", targetRoot: "vendor/hermes-skills" });

		expect(result.ok).toBe(true);
		expect(check(result, "host-hermes-config")).toMatchObject({
			status: "pass",
			details: { requiredEntry: "vendor/hermes-skills" },
		});
	});

	it("fails Hermes adoption when project skills are not registered", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-hermes-missing-config-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled\nambiguity-required: 0.2");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);

		installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		writeFileSync(join(dir, ".hermes", "config.yaml"), "model:\n  default: gpt-5.4\n");

		const result = runDoctor({ cwd: dir, host: "hermes" });

		expect(result.ok).toBe(false);
		expect(check(result, "host-hermes-config")).toMatchObject({
			status: "fail",
			details: { requiredEntry: ".hermes/skills" },
		});
	});

	it("fails Claude Code adoption when hook settings are missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-claude-missing-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);
		installHostSkillBundle({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const result = runDoctor({ cwd: dir, host: "claude-code" });

		expect(result.ok).toBe(false);
		expect(check(result, "claude-code-hooks")).toMatchObject({
			status: "fail",
			path: join(dir, ".claude", "settings.json"),
			recovery: {
				command: `paveda install claude-code --path ${join(dir, ".claude", "settings.json")} --write`,
			},
		});
	});

	it("passes Claude Code hook checks for an installed node cli command", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-claude-hooks-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill", "router: enabled");
		writeHarnessInstructions(harnessRoot);
		writeContextModules(harnessRoot);
		installHostSkillBundle({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});
		const settingsPath = join(dir, ".claude", "settings.json");
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				addPavedaClaudeCodeSettings({}, { cliPath: "/opt/paveda/dist/cli.js" }),
				null,
				2,
			)}\n`,
		);

		const result = runDoctor({ cwd: dir, host: "claude-code" });

		expect(result.ok).toBe(true);
		expect(check(result, "claude-code-hooks")?.status).toBe("pass");
		expect(formatDoctorReport(result)).toContain("PASS claude-code-hooks");
	});

	it("refuses to inspect symlinked Claude Code settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-claude-settings-symlink-"));
		tempDirs.push(dir);
		const settingsPath = join(dir, ".claude", "settings.json");
		const externalSettingsPath = join(dir, "external-settings.json");
		mkdirSync(join(dir, ".claude"), { recursive: true });
		writeFileSync(externalSettingsPath, '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
		symlinkSync(externalSettingsPath, settingsPath);

		const result = runDoctor({ cwd: dir, host: "claude-code" });
		const claudeHooks = check(result, "claude-code-hooks");

		expect(result.ok).toBe(false);
		expect(claudeHooks).toMatchObject({
			status: "fail",
			message: expect.stringContaining("Claude Code settings path must not use symlinks"),
			path: settingsPath,
		});
		expect(JSON.stringify(claudeHooks)).not.toContain("PRIVATE_VALUE");
		expect(readFileSync(externalSettingsPath, "utf8")).toBe(
			'{"env":{"PRIVATE_VALUE":"do-not-print"}}\n',
		);
	});

	it("reports executable project hooks and checks without running them", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-project-executables-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, ".harness", "hooks"), { recursive: true });
		mkdirSync(join(dir, ".harness", "hooks", "PostToolUse", "Edit"), { recursive: true });
		mkdirSync(join(dir, ".harness", "checks"), { recursive: true });
		writeFileSync(join(dir, ".harness", "hooks", "hook.sh"), "#!/bin/sh\necho hook\n", {
			mode: 0o755,
		});
		writeFileSync(
			join(dir, ".harness", "hooks", "PostToolUse", "Edit", "nested-hook.sh"),
			"#!/bin/sh\necho nested hook\n",
			{ mode: 0o755 },
		);
		writeFileSync(join(dir, ".harness", "checks", "check.sh"), "#!/bin/sh\necho check\n", {
			mode: 0o755,
		});
		const outsideHook = join(dir, "outside-hook.sh");
		const outsideCheck = join(dir, "outside-check.sh");
		writeFileSync(outsideHook, "#!/bin/sh\necho outside hook\n", { mode: 0o755 });
		writeFileSync(outsideCheck, "#!/bin/sh\necho outside check\n", { mode: 0o755 });
		symlinkSync(outsideHook, join(dir, ".harness", "hooks", "linked-hook.sh"));
		symlinkSync(outsideCheck, join(dir, ".harness", "checks", "linked-check.sh"));

		const result = runDoctor({ cwd: dir });

		expect(check(result, "project-hooks")).toMatchObject({
			status: "pass",
			details: { executableCount: 2 },
		});
		expect(check(result, "project-checks")).toMatchObject({
			status: "pass",
			details: { executableCount: 1 },
		});
		expect(readFileSync(join(dir, ".harness", "hooks", "hook.sh"), "utf8")).toContain("echo hook");
		expect(
			readFileSync(join(dir, ".harness", "hooks", "PostToolUse", "Edit", "nested-hook.sh"), "utf8"),
		).toContain("echo nested hook");
	});

	it("reports host/action enforcement tiers", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-enforcement-"));
		tempDirs.push(dir);

		const result = runDoctor({ cwd: dir, host: "claude-code", enforcement: true });

		expect(check(result, "enforcement-destructive-shell-command")).toMatchObject({
			status: "pass",
			details: {
				host: "claude-code",
				action: "destructive-shell-command",
				effectiveTier: "block",
				syntheticProbe: {
					executed: true,
					passed: true,
					expectedRuleIds: ["D-003"],
					decisions: expect.arrayContaining([
						expect.objectContaining({
							ruleId: "D-003",
							action: "deny",
							tier: "block",
							enforced: true,
						}),
					]),
				},
				hostCapability: {
					canBlockBeforeTool: true,
				},
			},
		});
		expect(check(result, "enforcement-mcp-routed-tool-call")).toMatchObject({
			status: "warn",
			details: {
				effectiveTier: "mediate",
				syntheticProbe: {
					executed: false,
					passed: null,
				},
				bypassPaths: expect.arrayContaining([
					"native tools remain outside MCP mediation unless restricted",
				]),
			},
		});
	});

	it("reports verified policy cache source in enforcement doctor", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-policy-source-"));
		tempDirs.push(dir);
		const cachePath = writePolicyCacheEntry(dir, ".harness/policy-cache.json");

		const result = runDoctor({
			cwd: dir,
			host: "codex",
			enforcement: true,
			policyCachePath: ".harness/policy-cache.json",
		});

		expect(result.policySource).toMatchObject({
			type: "bundle-cache",
			cachePath,
			keyId: "doctor-policy-key",
			canonicalSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(check(result, "policy-source")).toMatchObject({
			status: "pass",
			path: cachePath,
			details: {
				policySource: expect.objectContaining({
					type: "bundle-cache",
					keyId: "doctor-policy-key",
				}),
			},
		});
		expect(check(result, "enforcement-destructive-shell-command")).toMatchObject({
			details: {
				policySource: expect.objectContaining({
					type: "bundle-cache",
					keyId: "doctor-policy-key",
				}),
			},
		});
		expect(formatDoctorReport(result)).toContain(
			"PASS policy-source: Using verified policy bundle",
		);
	});

	it("fails enforcement doctor when configured policy cache is invalid", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-invalid-policy-source-"));
		tempDirs.push(dir);
		const cachePath = join(dir, ".harness", "policy-cache.json");
		mkdirSync(join(dir, ".harness"), { recursive: true });
		writeFileSync(cachePath, "{}\n");

		const result = runDoctor({
			cwd: dir,
			host: "codex",
			enforcement: true,
			policyCachePath: ".harness/policy-cache.json",
		});

		expect(result.ok).toBe(false);
		expect(check(result, "policy-source")).toMatchObject({
			status: "fail",
			path: cachePath,
			message: "Policy cache could not be loaded or verified.",
			details: {
				policySource: { type: "local" },
				error: expect.stringContaining("Policy bundle cache"),
			},
		});
	});

	it("fails enforcement doctor when verified policy cache drifts from local rules", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-policy-drift-"));
		tempDirs.push(dir);
		const cachePath = writePolicyCacheEntry(dir, ".harness/policy-cache.json", (bundle) => ({
			...bundle,
			rules: bundle.rules.slice(1),
		}));

		const result = runDoctor({
			cwd: dir,
			host: "codex",
			enforcement: true,
			policyCachePath: ".harness/policy-cache.json",
		});

		expect(result.ok).toBe(false);
		expect(check(result, "policy-source")).toMatchObject({
			status: "fail",
			path: cachePath,
			message: "Policy bundle metadata drifts from the local runtime.",
			details: {
				policySource: expect.objectContaining({
					type: "bundle-cache",
					keyId: "doctor-policy-key",
				}),
				runtimeDrift: expect.objectContaining({
					ok: false,
					missingRuleIds: [expect.any(String)],
				}),
			},
		});
	});

	it("reports Codex managed config status in enforcement doctor", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-codex-enforcement-"));
		tempDirs.push(dir);
		writeFileSync(
			join(dir, "requirements.toml"),
			renderCodexRequirementsToml({ command: "paveda hook codex" }),
		);

		const result = runDoctor({ cwd: dir, host: "codex", enforcement: true });

		expect(check(result, "enforcement-destructive-shell-command")).toMatchObject({
			status: "pass",
			details: {
				effectiveTier: "block",
				configFiles: [".codex/hooks.json", "requirements.toml"],
				managedConfigActive: true,
				syntheticProbe: {
					executed: true,
					passed: true,
				},
			},
		});
	});

	it("reports Hermes and Pi native adapter block tiers in enforcement doctor", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-native-adapter-enforcement-"));
		tempDirs.push(dir);

		const hermes = runDoctor({ cwd: dir, host: "hermes", enforcement: true });
		const pi = runDoctor({ cwd: dir, host: "pi", enforcement: true });

		expect(check(hermes, "enforcement-destructive-shell-command")).toMatchObject({
			status: "pass",
			details: {
				effectiveTier: "block",
				configFiles: [".hermes/config.yaml", ".hermes/agent-hooks/paveda-policy.sh"],
				syntheticProbe: {
					executed: true,
					passed: true,
					decisions: expect.arrayContaining([
						expect.objectContaining({
							ruleId: "D-003",
							tier: "block",
							enforced: true,
						}),
					]),
				},
			},
		});
		expect(check(pi, "enforcement-sensitive-file-mutation")).toMatchObject({
			status: "pass",
			details: {
				effectiveTier: "block",
				configFiles: [".pi/extensions/paveda-policy.ts", ".pi/AGENTS.md"],
				syntheticProbe: {
					executed: true,
					passed: true,
				},
			},
		});
	});

	it("runs synthetic workflow probes in enforcement doctor", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-workflow-probes-"));
		tempDirs.push(dir);

		const result = runDoctor({ cwd: dir, host: "claude-code", enforcement: true });

		expect(check(result, "enforcement-verification-before-commit")).toMatchObject({
			details: {
				syntheticProbe: {
					executed: true,
					passed: true,
					expectedRuleIds: ["W-003"],
					decisions: expect.arrayContaining([
						expect.objectContaining({
							ruleId: "W-003",
							action: "deny",
							enforced: true,
						}),
					]),
				},
			},
		});
		expect(check(result, "enforcement-dependency-manifest-mutation")).toMatchObject({
			details: {
				syntheticProbe: {
					executed: true,
					passed: true,
					expectedRuleIds: ["B-001"],
				},
			},
		});
	});

	it("fails enforcement probe status when synthetic policy decisions are missing", () => {
		const failedSyntheticProbe = { executed: true, passed: false };

		expect(
			resolveEnforcementProbeStatus({
				effectiveTier: "block",
				syntheticProbe: failedSyntheticProbe,
			}),
		).toBe("fail");
		expect(
			resolveEnforcementFailedProbes({
				effectiveTier: "block",
				syntheticProbe: failedSyntheticProbe,
			}),
		).toEqual(["synthetic-policy-decision"]);
		expect(
			resolveEnforcementProbeStatus({
				effectiveTier: "block",
				syntheticProbe: { executed: true, passed: true },
			}),
		).toBe("pass");
		expect(
			resolveEnforcementProbeStatus({
				effectiveTier: "mediate",
				syntheticProbe: { executed: false, passed: null },
			}),
		).toBe("warn");
	});

	it("fails enforcement doctor without a host", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-doctor-enforcement-no-host-"));
		tempDirs.push(dir);

		const result = runDoctor({ cwd: dir, enforcement: true });

		expect(result.ok).toBe(false);
		expect(check(result, "enforcement-host")).toMatchObject({
			status: "fail",
			message: "Enforcement doctor requires --host so capability can be assessed.",
		});
	});
});

function check(result: ReturnType<typeof runDoctor>, name: string) {
	return result.checks.find((item) => item.name === name);
}

function writeSkill(
	root: string,
	directory: string,
	name: string,
	description: string,
	extraFrontmatter = "",
): void {
	const path = join(root, directory);
	mkdirSync(path, { recursive: true });
	writeFileSync(
		join(path, "SKILL.md"),
		`---
name: ${name}
description: ${description}
${extraFrontmatter}
---

# ${name}
`,
	);
}

function writeHarnessInstructions(root: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(root === "" ? "AGENTS.md" : join(root, "AGENTS.md"), "# Instructions\n");
}

function writeContextModules(root: string): void {
	const contextRoot = join(root, "context-modules");
	mkdirSync(contextRoot, { recursive: true });
	writeFileSync(join(contextRoot, "backend-patterns.md"), "# Backend patterns\n");
	writeFileSync(join(contextRoot, "frontend-patterns.md"), "# Frontend patterns\n");
	writeFileSync(join(contextRoot, "worker-patterns.md"), "# Worker patterns\n");
	writeFileSync(join(contextRoot, "infra-patterns.md"), "# Infrastructure patterns\n");
}

function writePolicyCacheEntry(
	cwd: string,
	relativePath: string,
	transformBundle: (bundle: PolicyBundle) => PolicyBundle = (bundle) => bundle,
): string {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
	const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
	const bundle = transformBundle(
		createPolicyBundle({
			issuer: "doctor-policy-source-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		}),
	);
	const signedBundle = signPolicyBundle(bundle, { privateKeyPem, keyId: "doctor-policy-key" });
	const verification = verifySignedPolicyBundleWithKeyring(signedBundle, {
		keys: [{ keyId: "doctor-policy-key", publicKeyPem }],
	});
	const cacheEntry = createPolicyBundleCacheEntry(signedBundle, verification, {
		source: "https://policy.example.invalid/doctor-policy.signed.json",
		cachedAt: "2026-06-01T00:01:00.000Z",
	});
	const path = join(cwd, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cacheEntry, null, 2)}\n`);
	return path;
}
