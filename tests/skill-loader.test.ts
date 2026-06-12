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
	enableSkillRouter,
	findSkill,
	installBuiltinSkill,
	isSkillRouterEnabled,
	loadSkillStatus,
	loadSkills,
	parseSkillDocument,
	testSkillProcessContract,
	upsertSkillRouterFrontmatter,
} from "../src/skill-loader/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("skill loader", () => {
	it("parses Claude Code SKILL.md frontmatter", () => {
		const parsed = parseSkillDocument(`---
name: review
description: |
  코드 검토를 수행한다.
  위험을 먼저 보고한다.
argument-hint: "[--quick]"
allowed-tools: Bash, Read, Write, Agent
allowed-providers: claude-sonnet, gpt-4o
prefer-provider: gpt-4o
disable-model-invocation: false
router: enabled
trigger:
  paths: [src/**/*.ts, tests/**/*.ts]
  keywords: [구현, review]
ambiguity-required: 0.2
---

# Body
`);

		expect(parsed.frontmatter).toEqual({
			name: "review",
			description: "코드 검토를 수행한다.\n위험을 먼저 보고한다.",
			argumentHint: "[--quick]",
			allowedTools: ["Bash", "Read", "Write", "Agent"],
			allowedProviders: ["claude-sonnet", "gpt-4o"],
			preferProvider: "gpt-4o",
			disableModelInvocation: false,
			router: "enabled",
			trigger: {
				paths: ["src/**/*.ts", "tests/**/*.ts"],
				keywords: ["구현", "review"],
			},
			ambiguityRequired: 0.2,
		});
		expect(parsed.body).toBe("# Body\n");
	});

	it("loads project, user, and builtin skills with scope priority", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-skills-"));
		tempDirs.push(dir);
		const projectRoot = join(dir, "project", ".claude", "skills");
		const userRoot = join(dir, "user", "skills");
		const builtinRoot = join(dir, "builtin", "skills");

		writeSkill(builtinRoot, "do", "do", "builtin do");
		writeSkill(userRoot, "do", "do", "user do");
		writeSkill(projectRoot, "do", "do", "project do");
		writeSkill(userRoot, "review", "review", "user review");

		const skills = loadSkills({
			projectRoots: [projectRoot],
			userRoots: [userRoot],
			builtinRoots: [builtinRoot],
		});

		expect(skills.map((skill) => [skill.name, skill.scope, skill.frontmatter.description])).toEqual(
			[
				["do", "project", "project do"],
				["review", "user", "user review"],
			],
		);
	});

	it("reports selected and shadowed skill candidates", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-skill-status-"));
		tempDirs.push(dir);
		const projectRoot = join(dir, "project", ".harness", "skills");
		const userRoot = join(dir, "user", "skills");
		const builtinRoot = join(dir, "builtin", "skills");

		writeSkill(builtinRoot, "do", "do", "builtin do", "router: enabled");
		writeSkill(userRoot, "do", "do", "user do");
		writeSkill(projectRoot, "do", "do", "project do", "router: enabled");

		expect(
			loadSkillStatus({
				projectRoots: [projectRoot],
				userRoots: [userRoot],
				builtinRoots: [builtinRoot],
			}),
		).toEqual([
			{
				name: "do",
				selected: {
					scope: "project",
					path: join(projectRoot, "do", "SKILL.md"),
					relativePath: "do/SKILL.md",
					description: "project do",
					model: undefined,
					router: "enabled",
				},
				shadowed: [
					{
						scope: "user",
						path: join(userRoot, "do", "SKILL.md"),
						relativePath: "do/SKILL.md",
						description: "user do",
						model: undefined,
						router: undefined,
					},
					{
						scope: "builtin",
						path: join(builtinRoot, "do", "SKILL.md"),
						relativePath: "do/SKILL.md",
						description: "builtin do",
						model: undefined,
						router: "enabled",
					},
				],
				routerEnabled: true,
				issues: [],
			},
		]);
	});

	it("reports when a router-enabled builtin skill is shadowed by a non-router project skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-skill-status-shadow-"));
		tempDirs.push(dir);
		const projectRoot = join(dir, "project", ".claude", "skills");
		const builtinRoot = join(dir, "builtin", "skills");

		writeSkill(builtinRoot, "do", "do", "builtin do", "router: enabled");
		writeSkill(projectRoot, "do", "do", "project do");

		expect(
			loadSkillStatus({
				projectRoots: [projectRoot],
				userRoots: [],
				builtinRoots: [builtinRoot],
			})[0],
		).toMatchObject({
			name: "do",
			routerEnabled: false,
			issues: [
				{
					code: "router-enabled-skill-shadowed",
					message:
						"do is selected from project, but a router-enabled builtin candidate is shadowed.",
					recommendation: `Add "router: enabled" to ${join(
						projectRoot,
						"do",
						"SKILL.md",
					)} or install the builtin harness skill into a higher-priority skill root.`,
				},
			],
		});
	});

	it("loads the packaged Paveda harness bundle", () => {
		const skills = loadSkills({
			projectRoots: [],
			userRoots: [],
		});

		expect(skills.map((skill) => skill.name)).toEqual(
			expect.arrayContaining(["commit", "debug", "do", "plan", "pr", "specify", "verify"]),
		);
		expect(findSkill(skills, "do")).toMatchObject({
			scope: "builtin",
			relativePath: "do/SKILL.md",
			frontmatter: {
				router: "enabled",
				ambiguityRequired: 0.15,
			},
		});
	});

	it("tests packaged skill eval contracts deterministically", () => {
		const result = testSkillProcessContract({
			name: "do",
			projectRoots: [],
			userRoots: [],
		});

		expect(result).toMatchObject({
			name: "do",
			ok: true,
			issues: [],
		});
		expect(result.cases.map((item) => item.evalName)).toContain("do-code-test-gates");
		expect(result.cases.flatMap((item) => item.assertions).every((item) => item.ok)).toBe(true);
		expect(result.cases[0]).toMatchObject({
			evalId: "do-contract-shell-start",
			baselineExpectedFailure: expect.stringContaining("Paveda run id"),
		});
	});

	it("tests host-rendered packaged skill eval contracts", () => {
		for (const host of ["codex", "claude-code", "pi", "hermes"] as const) {
			const result = testSkillProcessContract({
				name: "do",
				host,
				projectRoots: [],
				userRoots: [],
			});

			expect(result).toMatchObject({
				name: "do",
				ok: true,
				issues: [],
			});
		}
	});

	it("fails skill eval contracts when required sections are missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-skill-eval-fail-"));
		tempDirs.push(dir);
		const root = join(dir, "skills");
		writeSkill(root, "do", "do", "minimal skill");
		mkdirSync(join(root, "do", "evals"), { recursive: true });
		writeFileSync(
			join(root, "do", "evals", "evals.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					skill: "do",
					cases: [
						{
							id: "missing-required-section",
							prompt: "run",
							expectedWithSkill: ["requiredGates"],
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const result = testSkillProcessContract({
			name: "do",
			projectRoots: [root],
			userRoots: [],
			builtinRoots: [],
		});

		expect(result.ok).toBe(false);
		expect(result.cases[0]?.assertions[0]).toMatchObject({
			ok: false,
			message: "pattern missing from skill body",
		});
	});

	it("rejects malformed skill eval schemas", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-skill-eval-schema-"));
		tempDirs.push(dir);
		const root = join(dir, "skills");
		writeSkill(root, "do", "do", "minimal skill");
		mkdirSync(join(root, "do", "evals"), { recursive: true });
		writeFileSync(
			join(root, "do", "evals", "evals.json"),
			`${JSON.stringify(
				{
					schemaVersion: 1,
					skill: "do",
					extra: true,
					cases: [
						{
							id: "bad-case",
							prompt: "run",
							unknown: true,
							assertions: [
								{
									type: "contains_section",
									pattern: "requiredGates",
									unknown: true,
								},
							],
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const result = testSkillProcessContract({
			name: "do",
			projectRoots: [root],
			userRoots: [],
			builtinRoots: [],
		});

		expect(result.ok).toBe(false);
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "evals.unknown_field" }),
				expect.objectContaining({ code: "eval.unknown_field" }),
				expect.objectContaining({ code: "eval.unknown_assertion_field" }),
			]),
		);
	});

	it("limits builtin skill discovery to harness manifest skill entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-manifest-builtin-skills-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "verify", "verify", "verify skill");
		writeSkill(builtinRoot, "experimental", "experimental", "unlisted skill");
		writeHarnessManifest(harnessRoot, {
			skills: [{ name: "verify", path: "skills/verify" }],
		});

		const skills = loadSkills({
			projectRoots: [],
			userRoots: [],
			builtinRoots: [builtinRoot],
		});

		expect(skills.map((skill) => skill.name)).toEqual(["verify"]);
	});

	it("does not install builtin skills omitted from the harness manifest", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-manifest-install-skill-"));
		tempDirs.push(dir);
		const harnessRoot = join(dir, "builtin");
		const builtinRoot = join(harnessRoot, "skills");
		writeSkill(builtinRoot, "do", "do", "do skill");
		writeSkill(builtinRoot, "verify", "verify", "verify skill");
		writeHarnessManifest(harnessRoot, {
			skills: [{ name: "do", path: "skills/do" }],
		});

		expect(() =>
			installBuiltinSkill({
				name: "verify",
				builtinRoots: [builtinRoot],
			}),
		).toThrow("Unknown builtin skill: verify");
	});

	it("fails builtin skill discovery when the harness manifest references a missing skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-manifest-missing-skill-"));
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
			loadSkills({
				projectRoots: [],
				userRoots: [],
				builtinRoots: [builtinRoot],
			}),
		).toThrow("Harness manifest references missing skill: verify");
	});

	it("installs the full builtin skill directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-dir-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin", "skills");
		const targetRoot = join(dir, "project", ".harness", "skills");

		writeSkill(builtinRoot, "do", "do", "builtin do", "router: enabled");
		mkdirSync(join(builtinRoot, "do", "references"), { recursive: true });
		writeFileSync(join(builtinRoot, "do", "references", "orchestrator.md"), "# Orchestrator\n");

		const result = installBuiltinSkill({
			name: "do",
			builtinRoots: [builtinRoot],
			targetRoot,
			write: true,
		});

		expect(result.targetPath).toBe(join(targetRoot, "do", "SKILL.md"));
		expect(existsSync(join(targetRoot, "do", "references", "orchestrator.md"))).toBe(true);
		expect(readFileSync(join(targetRoot, "do", "references", "orchestrator.md"), "utf8")).toBe(
			"# Orchestrator\n",
		);
	});

	it("resolves relative builtin install target roots against cwd", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-relative-root-"));
		tempDirs.push(dir);
		const projectRoot = join(dir, "project");
		const builtinRoot = join(dir, "builtin", "skills");
		mkdirSync(projectRoot, { recursive: true });
		writeSkill(builtinRoot, "do", "do", "builtin do");

		const result = installBuiltinSkill({
			name: "do",
			cwd: projectRoot,
			builtinRoots: [builtinRoot],
			targetRoot: "custom/skills",
			write: true,
		});

		expect(result.targetPath).toBe(join(projectRoot, "custom", "skills", "do", "SKILL.md"));
		expect(existsSync(join(projectRoot, "custom", "skills", "do", "SKILL.md"))).toBe(true);
	});

	it("upserts router metadata into skill frontmatter", () => {
		const raw = `---
name: do
description: do skill
---

# do
`;

		expect(upsertSkillRouterFrontmatter(raw)).toBe(`---
name: do
description: do skill
router: enabled
ambiguity-required: 0.2
---

# do
`);
		expect(upsertSkillRouterFrontmatter(upsertSkillRouterFrontmatter(raw))).toBe(
			upsertSkillRouterFrontmatter(raw),
		);
		expect(upsertSkillRouterFrontmatter(upsertSkillRouterFrontmatter(raw), 0.35)).toContain(
			"ambiguity-required: 0.35",
		);
		expect(
			upsertSkillRouterFrontmatter(upsertSkillRouterFrontmatter(raw, 0.35), 0.2, {
				preserveExistingAmbiguity: true,
			}),
		).toContain("ambiguity-required: 0.35");
	});

	it("enables router metadata on the selected project skill", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-enable-router-"));
		tempDirs.push(dir);
		const root = join(dir, ".claude", "skills");
		writeSkill(root, "do", "do", "project do");

		const dryRun = enableSkillRouter({
			cwd: dir,
			name: "do",
			userRoots: [],
			builtinRoots: [],
		});

		expect(dryRun).toMatchObject({
			name: "do",
			scope: "project",
			written: false,
			changed: true,
			routerEnabled: true,
			ambiguityRequired: 0.2,
		});
		expect(loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] })[0]?.frontmatter.router).toBe(
			undefined,
		);

		const written = enableSkillRouter({
			cwd: dir,
			name: "do",
			userRoots: [],
			builtinRoots: [],
			write: true,
		});

		expect(written).toMatchObject({
			written: true,
			changed: true,
		});
		expect(loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] })[0]).toMatchObject({
			frontmatter: {
				router: "enabled",
				ambiguityRequired: 0.2,
			},
		});
		expect(
			enableSkillRouter({
				cwd: dir,
				name: "do",
				userRoots: [],
				builtinRoots: [],
				write: true,
			}),
		).toMatchObject({
			written: false,
			changed: false,
			ambiguityRequired: 0.2,
		});
	});

	it("updates router ambiguity threshold only when explicitly requested", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-enable-router-threshold-"));
		tempDirs.push(dir);
		const root = join(dir, ".harness", "skills");
		writeSkill(root, "do", "do", "project do", "router: enabled\nambiguity-required: 0.35");

		expect(
			enableSkillRouter({
				cwd: dir,
				name: "do",
				userRoots: [],
				builtinRoots: [],
				write: true,
			}),
		).toMatchObject({
			written: false,
			changed: false,
			ambiguityRequired: 0.35,
		});

		expect(
			enableSkillRouter({
				cwd: dir,
				name: "do",
				userRoots: [],
				builtinRoots: [],
				ambiguityRequired: 0.45,
				write: true,
			}),
		).toMatchObject({
			written: true,
			changed: true,
			ambiguityRequired: 0.45,
		});
		expect(readFileSync(join(root, "do", "SKILL.md"), "utf8")).toContain(
			"ambiguity-required: 0.45",
		);
	});

	it("only enables router metadata for /do", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-enable-router-non-do-"));
		tempDirs.push(dir);
		const root = join(dir, ".harness", "skills");
		writeSkill(root, "review", "review", "review helper");

		expect(() =>
			enableSkillRouter({
				cwd: dir,
				name: "review",
				userRoots: [],
				builtinRoots: [],
				write: true,
			}),
		).toThrow("PAL Router metadata is only supported for /do");
		const [skill] = loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] });
		expect(skill?.name).toBe("review");
		expect(skill?.frontmatter).not.toHaveProperty("router");
	});

	it("refuses to write router metadata through a symlinked skill root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-enable-router-symlink-root-"));
		tempDirs.push(dir);
		const externalRoot = join(dir, "external-skills");
		const linkedRoot = join(dir, ".harness", "skills");
		writeSkill(externalRoot, "do", "do", "external do");
		mkdirSync(join(dir, ".harness"), { recursive: true });
		symlinkSync(externalRoot, linkedRoot);

		expect(() =>
			enableSkillRouter({
				cwd: dir,
				name: "do",
				userRoots: [],
				builtinRoots: [],
				write: true,
			}),
		).toThrow("Skill write path must not use symlinks");
		expect(readFileSync(join(externalRoot, "do", "SKILL.md"), "utf8")).not.toContain(
			"router: enabled",
		);
	});

	it("discovers the default Claude Code project skills directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-claude-skills-"));
		tempDirs.push(dir);
		writeSkill(join(dir, ".claude", "skills"), "commit", "commit", "commit helper");

		const skills = loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] });

		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			name: "commit",
			scope: "project",
			relativePath: "commit/SKILL.md",
			frontmatter: {
				description: "commit helper",
			},
		});
	});

	it("ignores .paveda skills unless they are passed as explicit roots", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-standard-skills-"));
		tempDirs.push(dir);
		const pavedaRoot = join(dir, ".paveda", "skills");
		writeSkill(pavedaRoot, "do", "do", "paveda do");

		const skills = loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] });

		expect(skills).toEqual([]);
		const explicitSkills = loadSkills({
			cwd: dir,
			projectRoots: [pavedaRoot],
			userRoots: [],
			builtinRoots: [],
		});

		expect(explicitSkills[0]).toMatchObject({
			name: "do",
			scope: "project",
			frontmatter: {
				description: "paveda do",
			},
		});
	});

	it("finds router-enabled skills from frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-router-skill-"));
		tempDirs.push(dir);
		const root = join(dir, ".harness", "skills");
		writeSkill(root, "do", "do", "routed do", "router: enabled");
		writeSkill(root, "review", "review", "manual review");

		const skills = loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] });

		const doSkill = findSkill(skills, "do");
		const reviewSkill = findSkill(skills, "review");
		expect(doSkill).toBeDefined();
		expect(reviewSkill).toBeDefined();
		expect(doSkill ? isSkillRouterEnabled(doSkill) : false).toBe(true);
		expect(reviewSkill ? isSkillRouterEnabled(reviewSkill) : true).toBe(false);
	});

	it("installs builtin skills into the project skill root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin");
		writeSkill(builtinRoot, "do", "do", "builtin do", "router: enabled");

		const dryRun = installBuiltinSkill({
			cwd: dir,
			name: "do",
			builtinRoots: [builtinRoot],
		});

		expect(dryRun).toMatchObject({
			name: "do",
			targetPath: join(dir, ".harness", "skills", "do", "SKILL.md"),
			written: false,
			overwritten: false,
		});

		const written = installBuiltinSkill({
			cwd: dir,
			name: "do",
			builtinRoots: [builtinRoot],
			write: true,
		});

		expect(written).toMatchObject({
			written: true,
			overwritten: false,
		});
		expect(loadSkills({ cwd: dir, userRoots: [], builtinRoots: [] })[0]).toMatchObject({
			name: "do",
			scope: "project",
			frontmatter: {
				router: "enabled",
			},
		});
		expect(() =>
			installBuiltinSkill({
				cwd: dir,
				name: "do",
				builtinRoots: [builtinRoot],
				write: true,
			}),
		).toThrow("Skill already exists");
		expect(
			installBuiltinSkill({
				cwd: dir,
				name: "do",
				builtinRoots: [builtinRoot],
				write: true,
				force: true,
			}),
		).toMatchObject({
			written: true,
			overwritten: true,
		});
	});

	it("refuses to install builtin skills through a symlinked target root", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-root-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin");
		const externalRoot = join(dir, "external-skills");
		const linkedRoot = join(dir, "linked-skills");
		writeSkill(builtinRoot, "do", "do", "builtin do");
		mkdirSync(externalRoot);
		symlinkSync(externalRoot, linkedRoot);

		expect(() =>
			installBuiltinSkill({
				cwd: dir,
				name: "do",
				builtinRoots: [builtinRoot],
				targetRoot: "linked-skills",
				write: true,
				force: true,
			}),
		).toThrow("Skill write path must not use symlinks");
		expect(existsSync(join(externalRoot, "do", "SKILL.md"))).toBe(false);
	});

	it("refuses to overwrite a symlinked installed SKILL.md", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-file-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin");
		const targetRoot = join(dir, ".harness", "skills");
		const externalSkill = join(dir, "external-SKILL.md");
		writeSkill(builtinRoot, "do", "do", "builtin do");
		mkdirSync(join(targetRoot, "do"), { recursive: true });
		writeFileSync(externalSkill, "external skill\n");
		symlinkSync(externalSkill, join(targetRoot, "do", "SKILL.md"));

		expect(() =>
			installBuiltinSkill({
				cwd: dir,
				name: "do",
				builtinRoots: [builtinRoot],
				write: true,
				force: true,
			}),
		).toThrow("Skill write path must not use symlinks");
		expect(readFileSync(externalSkill, "utf8")).toBe("external skill\n");
	});

	it("refuses to overwrite symlinked nested files during builtin skill installs", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-install-skill-nested-symlink-"));
		tempDirs.push(dir);
		const builtinRoot = join(dir, "builtin");
		const targetRoot = join(dir, ".harness", "skills");
		const externalReference = join(dir, "external-reference.md");
		writeSkill(builtinRoot, "do", "do", "builtin do");
		mkdirSync(join(builtinRoot, "do", "references"), { recursive: true });
		writeFileSync(join(builtinRoot, "do", "references", "test-rules.md"), "# Test rules\n");
		mkdirSync(join(targetRoot, "do", "references"), { recursive: true });
		writeFileSync(join(targetRoot, "do", "SKILL.md"), "local skill\n");
		writeFileSync(externalReference, "external reference\n");
		symlinkSync(externalReference, join(targetRoot, "do", "references", "test-rules.md"));

		expect(() =>
			installBuiltinSkill({
				cwd: dir,
				name: "do",
				builtinRoots: [builtinRoot],
				write: true,
				force: true,
			}),
		).toThrow("Skill write path must not use symlinks");
		expect(readFileSync(externalReference, "utf8")).toBe("external reference\n");
	});
});

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

function writeHarnessManifest(root: string, value: unknown): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
}
