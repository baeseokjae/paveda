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
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HostSkillBundleTarget,
	installHostSkillBundle,
	parseHostSkillBundleTarget,
	renderHostSkillText,
	resolveHostContextModuleRoot,
	resolveHostSkillRoot,
} from "../src/host-bundles/index.js";

const tempDirs: string[] = [];
const HOST_MATRIX: Array<{
	host: HostSkillBundleTarget;
	skillRoot: string;
	contextRoot: string;
	instructionFile: string;
	createsCodexMetadata: boolean;
	createsHermesConfig: boolean;
}> = [
	{
		host: "harness",
		skillRoot: ".harness/skills",
		contextRoot: ".harness/context-modules",
		instructionFile: ".harness/AGENTS.md",
		createsCodexMetadata: false,
		createsHermesConfig: false,
	},
	{
		host: "claude-code",
		skillRoot: ".claude/skills",
		contextRoot: ".claude/context-modules",
		instructionFile: ".claude/CLAUDE.md",
		createsCodexMetadata: false,
		createsHermesConfig: false,
	},
	{
		host: "codex",
		skillRoot: ".codex/skills",
		contextRoot: ".codex/context-modules",
		instructionFile: "AGENTS.md",
		createsCodexMetadata: true,
		createsHermesConfig: false,
	},
	{
		host: "pi",
		skillRoot: ".pi/skills",
		contextRoot: ".pi/context-modules",
		instructionFile: ".pi/AGENTS.md",
		createsCodexMetadata: false,
		createsHermesConfig: false,
	},
	{
		host: "hermes",
		skillRoot: ".hermes/skills",
		contextRoot: ".hermes/context-modules",
		instructionFile: ".hermes/AGENTS.md",
		createsCodexMetadata: false,
		createsHermesConfig: true,
	},
];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("host skill bundles", () => {
	it.each(HOST_MATRIX)("writes packaged harness assets for $host", (hostCase) => {
		const dir = mkdtempSync(join(tmpdir(), `paveda-host-matrix-${hostCase.host}-`));
		tempDirs.push(dir);

		const result = installHostSkillBundle({
			host: hostCase.host,
			cwd: dir,
			skills: ["do", "verify"],
			write: true,
		});

		expect(result).toMatchObject({
			host: hostCase.host,
			targetRoot: join(dir, ...hostCase.skillRoot.split("/")),
			written: true,
		});
		expect(result.skills.map((skill) => skill.name)).toEqual(["do", "verify"]);
		expect(result.contextModules.map((item) => item.name)).toEqual([
			"backend-patterns.md",
			"frontend-patterns.md",
			"worker-patterns.md",
			"infra-patterns.md",
		]);

		const instruction = readFileSync(join(dir, ...hostCase.instructionFile.split("/")), "utf8");
		expect(instruction).toContain(`- Workflow skills: \`${hostCase.skillRoot}\``);
		expect(instruction).toContain("- Project hooks: `.harness/hooks`");
		expect(instruction).toContain("- Project checks: `.harness/checks`");
		expect(instruction).toContain(`- Context modules: \`${hostCase.contextRoot}\``);
		expect(instruction).toContain(`- Harness instructions: \`${hostCase.instructionFile}\``);
		const hostProjectDir = hostCase.skillRoot.replace(/\/skills$/, "");
		if (hostCase.host !== "harness") {
			expect(instruction).not.toContain(`${hostProjectDir}/hooks`);
			expect(instruction).not.toContain(`${hostProjectDir}/checks`);
		}

		const doSkill = readFileSync(
			join(dir, ...hostCase.skillRoot.split("/"), "do", "SKILL.md"),
			"utf8",
		);
		expect(doSkill).toContain("# /do - Paveda Contract Shell");
		expect(doSkill).toContain("## Host-Native Execution");
		expect(doSkill).toContain("paveda projection status --host <host>");
		expect(doSkill).toContain("paveda verify --run <run_id>");
		expect(doSkill).not.toContain(".claude/hooks");
		expect(doSkill).not.toContain(".claude/checks");
		if (hostCase.host !== "harness") {
			expect(doSkill).not.toContain(`${hostProjectDir}/hooks`);
			expect(doSkill).not.toContain(`${hostProjectDir}/checks`);
		}

		const plannerAgent = readFileSync(
			join(dir, ...hostCase.skillRoot.split("/"), "do", "agents", "planner.md"),
			"utf8",
		);
		if (hostCase.host === "harness") {
			expect(plannerAgent).toMatch(/^model: frontier$/m);
		} else if (hostCase.host === "claude-code") {
			expect(plannerAgent).toMatch(/^model: opus$/m);
		} else {
			expect(plannerAgent).not.toMatch(/^model:/m);
		}

		expect(existsSync(join(dir, ...hostCase.skillRoot.split("/"), "verify", "SKILL.md"))).toBe(
			true,
		);
		expect(existsSync(join(dir, ...hostCase.contextRoot.split("/"), "backend-patterns.md"))).toBe(
			true,
		);
		expect(existsSync(join(dir, ...hostCase.contextRoot.split("/"), "frontend-patterns.md"))).toBe(
			true,
		);

		const hermesConfigPath = join(dir, ".hermes", "config.yaml");
		expect(existsSync(hermesConfigPath)).toBe(hostCase.createsHermesConfig);
		if (hostCase.createsHermesConfig) {
			expect(result.hostConfigFile).toMatchObject({
				targetPath: hermesConfigPath,
				exists: false,
				written: true,
				registered: false,
				requiredEntry: ".hermes/skills",
			});
			expect(readFileSync(hermesConfigPath, "utf8")).toContain("  external_dirs:");
			expect(readFileSync(hermesConfigPath, "utf8")).toContain("    - .hermes/skills");
		} else {
			expect(result.hostConfigFile).toBeUndefined();
		}

		const codexMetadataPath = join(
			dir,
			...hostCase.skillRoot.split("/"),
			"do",
			"agents",
			"openai.yaml",
		);
		expect(existsSync(codexMetadataPath)).toBe(hostCase.createsCodexMetadata);
	});

	it("dry-runs a Codex skill bundle without writing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "verify", "verify", "verify skill");

		const result = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			skills: ["do", "verify"],
		});

		expect(result).toMatchObject({
			host: "codex",
			targetRoot: join(dir, ".codex", "skills"),
			written: false,
			force: false,
		});
		expect(result.skills.map((skill) => [skill.name, skill.targetPath, skill.exists])).toEqual([
			["do", join(dir, ".codex", "skills", "do", "SKILL.md"), false],
			["verify", join(dir, ".codex", "skills", "verify", "SKILL.md"), false],
		]);
		expect(existsSync(join(dir, ".codex", "skills", "do", "SKILL.md"))).toBe(false);
	});

	it("writes the full skill directory to a host default root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-write-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		mkdirSync(join(builtinRoot, "do", "references"), { recursive: true });
		writeFileSync(join(builtinRoot, "do", "references", "orchestrator.md"), "# Orchestrator\n");

		const result = installHostSkillBundle({
			host: "pi",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.targetRoot).toBe(join(dir, ".pi", "skills"));
		expect(result.skills).toHaveLength(1);
		expect(readFileSync(join(dir, ".pi", "skills", "do", "SKILL.md"), "utf8")).toContain(
			"name: do",
		);
		expect(
			readFileSync(join(dir, ".pi", "skills", "do", "references", "orchestrator.md"), "utf8"),
		).toBe("# Orchestrator\n");
	});

	it("resolves custom host bundle target roots against cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-custom-root-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			[
				"Script: `.harness/skills/do/scripts/run.sh`",
				"Shell: ${PROJECT_ROOT}/.harness/skills/do/scripts/run.sh",
				"Instruction file: `.harness/AGENTS.md`",
			].join("\n"),
		);
		writeHarnessInstructions(harnessRoot, "- Workflow skills: `.harness/skills`\n");

		const result = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot: "custom/skills",
			write: true,
		});

		expect(result.targetRoot).toBe(join(dir, "custom", "skills"));
		expect(existsSync(join(dir, ".codex", "skills", "do", "SKILL.md"))).toBe(false);
		expect(existsSync(join(dir, "custom", "skills", "do", "agents", "openai.yaml"))).toBe(true);

		const renderedSkill = readFileSync(join(dir, "custom", "skills", "do", "SKILL.md"), "utf8");
		expect(renderedSkill).toContain("`custom/skills/do/scripts/run.sh`");
		expect(renderedSkill).toContain("${PROJECT_ROOT}/custom/skills/do/scripts/run.sh");
		expect(renderedSkill).toContain("`AGENTS.md`");
		const renderedInstructions = readFileSync(join(dir, "AGENTS.md"), "utf8");
		expect(renderedInstructions).toContain("`custom/skills`");
	});

	it("renders absolute custom target root shell paths without project root prefixes", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-absolute-custom-root-"));
		const externalDir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-external-root-"));
		tempDirs.push(dir, externalDir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		const targetRoot = join(externalDir, "codex-skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			[
				"Script: `.harness/skills/do/scripts/run.sh`",
				"Shell: ${PROJECT_ROOT}/.harness/skills/do/scripts/run.sh",
			].join("\n"),
		);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot,
			write: true,
		});

		const renderedSkill = readFileSync(join(targetRoot, "do", "SKILL.md"), "utf8");
		expect(renderedSkill).toContain(`\`${targetRoot}/do/scripts/run.sh\``);
		expect(renderedSkill).toContain(`${targetRoot}/do/scripts/run.sh`);
		expect(renderedSkill).not.toContain(`\${PROJECT_ROOT}/${targetRoot}`);
	});

	it("registers custom Hermes target roots in config", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-hermes-custom-root-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			"Script: `.harness/skills/do/scripts/run.sh`",
		);

		const result = installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			targetRoot: "vendor/hermes-skills",
			write: true,
		});

		expect(result.targetRoot).toBe(join(dir, "vendor", "hermes-skills"));
		expect(result.hostConfigFile).toMatchObject({
			targetPath: join(dir, ".hermes", "config.yaml"),
			written: true,
			requiredEntry: "vendor/hermes-skills",
		});
		const config = readFileSync(join(dir, ".hermes", "config.yaml"), "utf8");
		expect(config).toContain("    - vendor/hermes-skills");
		expect(config).not.toContain("    - .hermes/skills");
		const renderedSkill = readFileSync(
			join(dir, "vendor", "hermes-skills", "do", "SKILL.md"),
			"utf8",
		);
		expect(renderedSkill).toContain("`vendor/hermes-skills/do/scripts/run.sh`");
	});

	it("uses harness manifest skill entries for default host bundle installs", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-manifest-skills-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "verify", "verify", "verify skill");
		writeHarnessManifest(harnessRoot, {
			skills: [{ name: "verify", path: "skills/verify" }],
		});

		const result = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.skills.map((skill) => skill.name)).toEqual(["verify"]);
		expect(existsSync(join(dir, ".codex", "skills", "verify", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dir, ".codex", "skills", "do", "SKILL.md"))).toBe(false);
	});

	it("keeps optional manifest skills out of default installs unless requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-manifest-optional-skills-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "review", "review", "review skill");
		writeHarnessManifest(harnessRoot, {
			skills: [
				{ name: "do", path: "skills/do" },
				{ name: "review", path: "skills/review", optional: true },
			],
		});

		const defaultResult = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
		});

		expect(defaultResult.skills.map((skill) => skill.name)).toEqual(["do"]);

		const explicitResult = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			skills: ["review"],
		});

		expect(explicitResult.skills.map((skill) => skill.name)).toEqual(["review"]);

		const optionalResult = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			includeOptional: true,
		});

		expect(optionalResult.skills.map((skill) => skill.name)).toEqual(["do", "review"]);
	});

	it("rejects explicit host bundle skills omitted from the harness manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-manifest-skill-reject-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "verify", "verify", "verify skill");
		writeHarnessManifest(harnessRoot, {
			skills: [{ name: "do", path: "skills/do" }],
		});

		expect(() =>
			installHostSkillBundle({
				host: "codex",
				cwd: dir,
				builtinRoots: [builtinRoot],
				skills: ["verify"],
			}),
		).toThrow("Unknown builtin skill: verify");
	});

	it("fails host bundle installs when the harness manifest references a missing skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-manifest-missing-skill-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeHarnessManifest(harnessRoot, {
			skills: [
				{ name: "do", path: "skills/do" },
				{ name: "verify", path: "skills/verify" },
			],
		});

		expect(() =>
			installHostSkillBundle({
				host: "codex",
				cwd: dir,
				builtinRoots: [builtinRoot],
			}),
		).toThrow("Harness manifest references missing skill: verify");
	});

	it("renders host-specific project paths in copied text files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-render-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			[
				"템플릿은 `.harness/skills/do/templates/product-spec.md`에 있다.",
				"스크립트: ${PROJECT_ROOT}/.harness/skills/do/scripts/detect-stagnation.sh",
				"컨텍스트: `.harness/context-modules/backend-patterns.md`",
				"설정: `.harness/AGENTS.md`",
			].join("\n"),
		);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const rendered = readFileSync(join(dir, ".codex", "skills", "do", "SKILL.md"), "utf8");
		expect(rendered).toContain("`.codex/skills/do/templates/product-spec.md`");
		expect(rendered).toContain("${PROJECT_ROOT}/.codex/skills/do/scripts/detect-stagnation.sh");
		expect(rendered).toContain("`.codex/context-modules/backend-patterns.md`");
		expect(rendered).toContain("`AGENTS.md`");
		expect(rendered).not.toContain(".harness/skills");
		expect(rendered).not.toContain(".harness/context-modules");
		expect(rendered).not.toContain(".harness/AGENTS.md");
		expect(rendered).not.toContain(".claude/skills");
		expect(rendered).not.toContain(".claude/context-modules");
		expect(rendered).not.toContain(".claude/CLAUDE.md");
	});

	it("renders canonical harness paths into Claude Code paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-claude-render-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			[
				"템플릿은 `.harness/skills/do/templates/product-spec.md`에 있다.",
				"컨텍스트: `.harness/context-modules/backend-patterns.md`",
				"설정: `.harness/AGENTS.md`",
			].join("\n"),
		);

		installHostSkillBundle({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const rendered = readFileSync(join(dir, ".claude", "skills", "do", "SKILL.md"), "utf8");
		expect(rendered).toContain("`.claude/skills/do/templates/product-spec.md`");
		expect(rendered).toContain("`.claude/context-modules/backend-patterns.md`");
		expect(rendered).toContain("`.claude/CLAUDE.md`");
		expect(rendered).not.toContain(".harness/skills");
		expect(rendered).not.toContain(".harness/context-modules");
		expect(rendered).not.toContain(".harness/AGENTS.md");
	});

	it("writes host instruction files from the canonical harness instructions", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-instructions-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeHarnessInstructions(
			harnessRoot,
			[
				"# Instructions",
				"",
				"- Skills: `.harness/skills`",
				"- Hooks: `.harness/hooks`",
				"- Checks: `.harness/checks`",
				"- Config: `.harness/AGENTS.md`",
				"",
			].join("\n"),
		);

		const result = installHostSkillBundle({
			host: "claude-code",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.instructionFile).toMatchObject({
			sourcePath: join(harnessRoot, "AGENTS.md"),
			targetPath: join(dir, ".claude", "CLAUDE.md"),
			exists: false,
			written: true,
			overwritten: false,
		});
		const rendered = readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8");
		expect(rendered).toContain("`.claude/skills`");
		expect(rendered).toContain("`.harness/hooks`");
		expect(rendered).toContain("`.harness/checks`");
		expect(rendered).toContain("`.claude/CLAUDE.md`");
		expect(rendered).not.toContain(".harness/skills");
		expect(rendered).not.toContain(".harness/AGENTS.md");
	});

	it("keeps project hook and check paths under the Paveda harness directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-project-extension-paths-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(
			builtinRoot,
			"do",
			"do",
			"do skill",
			"",
			[
				"Project hooks: `.harness/hooks`",
				"Project checks: `.harness/checks`",
				"Legacy hooks: `.claude/hooks`",
				"Legacy checks: `.claude/checks`",
			].join("\n"),
		);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const rendered = readFileSync(join(dir, ".codex", "skills", "do", "SKILL.md"), "utf8");
		expect(rendered).toContain("Project hooks: `.harness/hooks`");
		expect(rendered).toContain("Project checks: `.harness/checks`");
		expect(rendered).toContain("Legacy hooks: `.harness/hooks`");
		expect(rendered).toContain("Legacy checks: `.harness/checks`");
		expect(rendered).not.toContain(".codex/hooks");
		expect(rendered).not.toContain(".codex/checks");
		expect(rendered).not.toContain(".claude/hooks");
		expect(rendered).not.toContain(".claude/checks");
	});

	it("renders host-specific model hints from Paveda model tiers", () => {
		const source = ["---", "name: do", "model: frontier", "---", "", "model: standard", ""].join(
			"\n",
		);
		const harness = renderHostSkillText(source, "harness");
		const claudeCode = renderHostSkillText(source, "claude-code");
		const codex = renderHostSkillText(source, "codex");
		const pi = renderHostSkillText(source, "pi");
		const hermes = renderHostSkillText(source, "hermes");

		expect(readFrontmatter(harness)).toContain("model: frontier");
		expect(readFrontmatter(claudeCode)).toContain("model: opus");
		expect(readFrontmatter(codex)).not.toContain("model:");
		expect(readFrontmatter(pi)).not.toContain("model:");
		expect(readFrontmatter(hermes)).not.toContain("model:");
		expect(harness).toContain("\nmodel: standard\n");
		expect(claudeCode).toContain("\nmodel: standard\n");
		expect(codex).toContain("\nmodel: standard\n");
		expect(pi).toContain("\nmodel: standard\n");
		expect(hermes).toContain("\nmodel: standard\n");
	});

	it("writes host context modules from the canonical harness context", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-context-modules-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeContextModules(
			harnessRoot,
			"Backend: `.harness/context-modules/backend-patterns.md` and `.harness/skills/do/SKILL.md`\n",
		);

		const result = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.contextModules).toHaveLength(4);
		expect(result.contextModules[0]).toMatchObject({
			name: "backend-patterns.md",
			targetPath: join(dir, ".codex", "context-modules", "backend-patterns.md"),
			exists: false,
			written: true,
			overwritten: false,
		});
		const rendered = readFileSync(
			join(dir, ".codex", "context-modules", "backend-patterns.md"),
			"utf8",
		);
		expect(rendered).toContain("`.codex/context-modules/backend-patterns.md`");
		expect(rendered).toContain("`.codex/skills/do/SKILL.md`");
		expect(rendered).not.toContain(".harness/context-modules");
	});

	it("uses harness manifest entries for instruction and context module sources", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-manifest-context-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		const contextRoot = join(harnessRoot, "context-modules");
		writeSkill(builtinRoot, "do", "do", "do skill");
		mkdirSync(contextRoot, { recursive: true });
		writeFileSync(
			join(harnessRoot, "GUIDE.md"),
			"Context: `.harness/context-modules/security-patterns.md`\n",
		);
		writeFileSync(join(contextRoot, "backend-patterns.md"), "# Backend patterns\n");
		writeFileSync(
			join(contextRoot, "security-patterns.md"),
			"Security: `.harness/skills/do/SKILL.md`\n",
		);
		writeFileSync(join(contextRoot, "frontend-patterns.md"), "# Not declared\n");
		writeHarnessManifest(harnessRoot, {
			instructions: { path: "GUIDE.md" },
			contextModules: [
				{ name: "backend-patterns", path: "context-modules/backend-patterns.md" },
				{ name: "security-patterns", path: "context-modules/security-patterns.md" },
			],
			skills: [{ name: "do", path: "skills/do" }],
		});

		const result = installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
			"`.codex/context-modules/security-patterns.md`",
		);
		expect(result.contextModules.map((module) => module.name)).toEqual([
			"backend-patterns.md",
			"security-patterns.md",
		]);
		expect(
			readFileSync(join(dir, ".codex", "context-modules", "security-patterns.md"), "utf8"),
		).toContain("`.codex/skills/do/SKILL.md`");
		expect(existsSync(join(dir, ".codex", "context-modules", "frontend-patterns.md"))).toBe(false);
	});

	it("prevents context module overwrites unless force is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-context-conflict-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeContextModules(harnessRoot, "# New backend patterns\n");
		mkdirSync(join(dir, ".hermes", "context-modules"), { recursive: true });
		writeFileSync(join(dir, ".hermes", "context-modules", "backend-patterns.md"), "# Local\n");

		expect(() =>
			installHostSkillBundle({
				host: "hermes",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow(/Host skill bundle target already exists/);

		const result = installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
			force: true,
		});

		expect(result.contextModules[0]).toMatchObject({
			targetPath: join(dir, ".hermes", "context-modules", "backend-patterns.md"),
			exists: true,
			written: true,
			overwritten: true,
		});
		expect(
			readFileSync(join(dir, ".hermes", "context-modules", "backend-patterns.md"), "utf8"),
		).toBe("# New backend patterns\n");
	});

	it("prevents instruction file overwrites unless force is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-instruction-conflict-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeHarnessInstructions(harnessRoot, "# New instructions\n");
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "AGENTS.md"), "# Local instructions\n");

		expect(() =>
			installHostSkillBundle({
				host: "pi",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow(/Host skill bundle target already exists/);

		const result = installHostSkillBundle({
			host: "pi",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
			force: true,
		});

		expect(result.instructionFile).toMatchObject({
			targetPath: join(dir, ".pi", "AGENTS.md"),
			exists: true,
			written: true,
			overwritten: true,
		});
		expect(readFileSync(join(dir, ".pi", "AGENTS.md"), "utf8")).toBe("# New instructions\n");
	});

	it("keeps canonical harness instructions under the harness directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-harness-instructions-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeHarnessInstructions(
			harnessRoot,
			[
				"# Instructions",
				"",
				"- Skills: `.harness/skills`",
				"- Config: `.harness/AGENTS.md`",
				"",
			].join("\n"),
		);

		const result = installHostSkillBundle({
			host: "harness",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.instructionFile).toMatchObject({
			targetPath: join(dir, ".harness", "AGENTS.md"),
			written: true,
		});
		const rendered = readFileSync(join(dir, ".harness", "AGENTS.md"), "utf8");
		expect(rendered).toContain("`.harness/skills`");
		expect(rendered).toContain("`.harness/AGENTS.md`");
	});

	it("generates Codex openai.yaml metadata for installed skills", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-openai-yaml-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(
			builtinRoot,
			"pr",
			"pr",
			"Create pull requests with GitHub Flow and summarize validation evidence.",
		);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const metadata = readFileSync(
			join(dir, ".codex", "skills", "pr", "agents", "openai.yaml"),
			"utf8",
		);
		expect(metadata).toContain('display_name: "PR"');
		expect(metadata).toContain(
			'short_description: "Create pull requests with GitHub Flow and summarize validation"',
		);
		expect(metadata).toContain('brand_color: "#111827"');
		expect(metadata).toContain('default_prompt: "Use $pr from the Paveda harness."');
		expect(metadata).toContain("allow_implicit_invocation: true");
	});

	it("expands short Codex descriptions without duplicated filler words", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-short-openai-yaml-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "pr", "pr", "PR workflow skill");

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		const metadata = readFileSync(
			join(dir, ".codex", "skills", "pr", "agents", "openai.yaml"),
			"utf8",
		);
		expect(metadata).toContain('short_description: "Paveda PR workflow skill"');
		expect(metadata).not.toContain("workflow workflow");
	});

	it("does not generate Codex-only metadata for other host bundles", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-no-openai-yaml-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "Paveda implementation workflow skill");

		installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(existsSync(join(dir, ".hermes", "skills", "do", "agents", "openai.yaml"))).toBe(false);
	});

	it("merges Hermes skill registration into an existing config file", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-hermes-config-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "Paveda implementation workflow skill");
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(
			join(dir, ".hermes", "config.yaml"),
			[
				"model:",
				"  default: gpt-5.4",
				"skills:",
				"  disabled:",
				"    - local-only",
				"terminal:",
				"  timeout: 180",
				"",
			].join("\n"),
		);

		const result = installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.hostConfigFile).toMatchObject({
			targetPath: join(dir, ".hermes", "config.yaml"),
			exists: true,
			written: true,
			overwritten: false,
			registered: false,
		});
		const config = readFileSync(join(dir, ".hermes", "config.yaml"), "utf8");
		expect(config).toContain("model:\n  default: gpt-5.4");
		expect(config).toContain("skills:\n  external_dirs:\n    - .hermes/skills\n  disabled:");
		expect(config).toContain("terminal:\n  timeout: 180");
	});

	it("does not duplicate an existing Hermes skill registration", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-hermes-existing-config-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "Paveda implementation workflow skill");
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(
			join(dir, ".hermes", "config.yaml"),
			["skills:", "  external_dirs:", "    - .hermes/skills", ""].join("\n"),
		);

		const result = installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(result.hostConfigFile).toMatchObject({
			exists: true,
			written: false,
			registered: true,
		});
		const config = readFileSync(join(dir, ".hermes", "config.yaml"), "utf8");
		expect(config.match(/\.hermes\/skills/g)).toHaveLength(1);
	});

	it("prevents accidental overwrites unless force is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-conflict-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "canonical do");
		const targetRoot = join(dir, ".hermes", "skills");
		mkdirSync(join(targetRoot, "do"), { recursive: true });
		writeFileSync(join(targetRoot, "do", "SKILL.md"), "local do\n");

		expect(
			installHostSkillBundle({
				host: "hermes",
				cwd: dir,
				builtinRoots: [builtinRoot],
			}).skills[0],
		).toMatchObject({
			exists: true,
			written: false,
			overwritten: false,
		});
		expect(() =>
			installHostSkillBundle({
				host: "hermes",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow(/Host skill bundle target already exists/);

		const result = installHostSkillBundle({
			host: "hermes",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
			force: true,
		});

		expect(result.skills[0]).toMatchObject({ overwritten: true });
		expect(readFileSync(join(targetRoot, "do", "SKILL.md"), "utf8")).toContain("canonical do");
	});

	it("prevents nested skill file overwrites unless force is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-nested-conflict-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "canonical do");
		mkdirSync(join(builtinRoot, "do", "agents"), { recursive: true });
		writeFileSync(join(builtinRoot, "do", "agents", "planner.md"), "canonical planner\n");
		const targetSkillRoot = join(dir, ".codex", "skills", "do");
		mkdirSync(join(targetSkillRoot, "agents"), { recursive: true });
		writeFileSync(join(targetSkillRoot, "agents", "planner.md"), "local planner\n");

		expect(() =>
			installHostSkillBundle({
				host: "codex",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow(/Host skill bundle target already exists/);
		expect(readFileSync(join(targetSkillRoot, "agents", "planner.md"), "utf8")).toBe(
			"local planner\n",
		);
		expect(existsSync(join(targetSkillRoot, "SKILL.md"))).toBe(false);

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
			force: true,
		});

		expect(readFileSync(join(targetSkillRoot, "agents", "planner.md"), "utf8")).toBe(
			"canonical planner\n",
		);
	});

	it("prevents generated Codex metadata overwrites unless force is set", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-metadata-conflict-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		writeSkill(builtinRoot, "do", "do", "Paveda implementation workflow skill");
		const metadataPath = join(dir, ".codex", "skills", "do", "agents", "openai.yaml");
		mkdirSync(join(dir, ".codex", "skills", "do", "agents"), { recursive: true });
		writeFileSync(metadataPath, "local metadata\n");

		expect(() =>
			installHostSkillBundle({
				host: "codex",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow(/Host skill bundle target already exists/);
		expect(readFileSync(metadataPath, "utf8")).toBe("local metadata\n");

		installHostSkillBundle({
			host: "codex",
			cwd: dir,
			builtinRoots: [builtinRoot],
			write: true,
			force: true,
		});

		expect(readFileSync(metadataPath, "utf8")).toContain('default_prompt: "Use $do');
	});

	it("refuses to write host bundles through a symlinked target root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-root-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		const externalRoot = join(dir, "external-skills");
		const linkedRoot = join(dir, "linked-skills");
		writeSkill(builtinRoot, "do", "do", "canonical do");
		mkdirSync(externalRoot);
		symlinkSync(externalRoot, linkedRoot);

		expect(() =>
			installHostSkillBundle({
				host: "codex",
				cwd: dir,
				builtinRoots: [builtinRoot],
				targetRoot: "linked-skills",
				write: true,
				force: true,
			}),
		).toThrow("Host skill bundle target must not use symlinks");
		expect(existsSync(join(externalRoot, "do", "SKILL.md"))).toBe(false);
	});

	it("refuses to overwrite symlinked host instruction files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-instruction-symlink-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		const externalInstruction = join(dir, "external-instruction.md");
		writeSkill(builtinRoot, "do", "do", "canonical do");
		writeHarnessInstructions(harnessRoot, "# New instructions\n");
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(externalInstruction, "# External instructions\n");
		symlinkSync(externalInstruction, join(dir, ".pi", "AGENTS.md"));

		expect(() =>
			installHostSkillBundle({
				host: "pi",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
				force: true,
			}),
		).toThrow("Host skill bundle target must not use symlinks");
		expect(readFileSync(externalInstruction, "utf8")).toBe("# External instructions\n");
	});

	it("refuses to merge Hermes config through a symlinked config file", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-bundle-hermes-config-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		const externalConfig = join(dir, "external-config.yaml");
		writeSkill(builtinRoot, "do", "do", "canonical do");
		mkdirSync(join(dir, ".hermes"), { recursive: true });
		writeFileSync(externalConfig, "model:\n  default: gpt-5.4\n");
		symlinkSync(externalConfig, join(dir, ".hermes", "config.yaml"));

		expect(() =>
			installHostSkillBundle({
				host: "hermes",
				cwd: dir,
				builtinRoots: [builtinRoot],
				write: true,
				force: true,
			}),
		).toThrow("Host skill bundle target must not use symlinks");
		expect(readFileSync(externalConfig, "utf8")).toBe("model:\n  default: gpt-5.4\n");
	});

	it("rejects unknown host bundle targets", () => {
		expect(() => parseHostSkillBundleTarget("unknown")).toThrow(
			"Unsupported skill bundle host: unknown",
		);
	});

	it("resolves host skill roots for CLI inspection", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-host-root-"));
		tempDirs.push(dir);

		expect(resolveHostSkillRoot("harness", dir)).toBe(join(dir, ".harness", "skills"));
		expect(resolveHostSkillRoot("claude-code", dir)).toBe(join(dir, ".claude", "skills"));
		expect(resolveHostSkillRoot("codex", dir)).toBe(join(dir, ".codex", "skills"));
		expect(resolveHostSkillRoot("pi", dir)).toBe(join(dir, ".pi", "skills"));
		expect(resolveHostSkillRoot("hermes", dir)).toBe(join(dir, ".hermes", "skills"));
		expect(resolveHostSkillRoot("codex", dir, "vendor/codex-skills")).toBe(
			join(dir, "vendor", "codex-skills"),
		);
		expect(resolveHostContextModuleRoot("harness", dir)).toBe(
			join(dir, ".harness", "context-modules"),
		);
		expect(resolveHostContextModuleRoot("claude-code", dir)).toBe(
			join(dir, ".claude", "context-modules"),
		);
		expect(resolveHostContextModuleRoot("codex", dir)).toBe(join(dir, ".codex", "context-modules"));
		expect(resolveHostContextModuleRoot("pi", dir)).toBe(join(dir, ".pi", "context-modules"));
		expect(resolveHostContextModuleRoot("hermes", dir)).toBe(
			join(dir, ".hermes", "context-modules"),
		);
	});
});

function readFrontmatter(raw: string): string {
	const end = raw.indexOf("\n---", 4);
	return raw.slice(4, end);
}

function writeSkill(
	root: string,
	name: string,
	frontmatterName: string,
	description: string,
	extraFrontmatter = "",
	body = "",
): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(
		join(root, name, "SKILL.md"),
		[
			"---",
			`name: ${frontmatterName}`,
			`description: ${description}`,
			extraFrontmatter,
			"---",
			"",
			`# ${name}`,
			body,
			"",
		]
			.filter(Boolean)
			.join("\n"),
	);
}

function writeHarnessInstructions(root: string, body: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), body);
}

function writeHarnessManifest(root: string, value: unknown): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function writeContextModules(root: string, backendBody: string): void {
	const contextRoot = join(root, "context-modules");
	mkdirSync(contextRoot, { recursive: true });
	writeFileSync(join(contextRoot, "backend-patterns.md"), backendBody);
	writeFileSync(join(contextRoot, "frontend-patterns.md"), "# Frontend patterns\n");
	writeFileSync(join(contextRoot, "worker-patterns.md"), "# Worker patterns\n");
	writeFileSync(join(contextRoot, "infra-patterns.md"), "# Infrastructure patterns\n");
}
