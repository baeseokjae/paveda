#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const harnessManifest = JSON.parse(
	readFileSync(join(root, "assets", "harness", "manifest.json"), "utf8"),
);
const canonicalInstructionPath = readCanonicalInstructionPath(harnessManifest);
const canonicalContextModulePaths = readCanonicalContextModulePaths(harnessManifest);
const canonicalSkillEntries = readCanonicalSkillEntries(harnessManifest);
const canonicalSkillNames = canonicalSkillEntries.map((skill) => skill.name);
const canonicalCoreSkillEntries = canonicalSkillEntries.filter((skill) => !skill.optional);
const canonicalOptionalSkillNames = canonicalSkillEntries
	.filter((skill) => skill.optional)
	.map((skill) => skill.name);
const destination = process.env.PAVEDA_PACK_DESTINATION ?? tmpdir();
const hostSmokeMatrix = [
	{
		host: "harness",
		skillRoot: ".harness/skills",
		contextRoot: ".harness/context-modules",
		instructionFile: ".harness/AGENTS.md",
		hermesConfigFile: null,
		createsCodexMetadata: false,
	},
	{
		host: "claude-code",
		skillRoot: ".claude/skills",
		contextRoot: ".claude/context-modules",
		instructionFile: ".claude/CLAUDE.md",
		hermesConfigFile: null,
		createsCodexMetadata: false,
	},
	{
		host: "codex",
		skillRoot: ".codex/skills",
		contextRoot: ".codex/context-modules",
		instructionFile: "AGENTS.md",
		hermesConfigFile: null,
		createsCodexMetadata: true,
	},
	{
		host: "pi",
		skillRoot: ".pi/skills",
		contextRoot: ".pi/context-modules",
		instructionFile: ".pi/AGENTS.md",
		hermesConfigFile: null,
		createsCodexMetadata: false,
	},
	{
		host: "hermes",
		skillRoot: ".hermes/skills",
		contextRoot: ".hermes/context-modules",
		instructionFile: ".hermes/AGENTS.md",
		hermesConfigFile: ".hermes/config.yaml",
		createsCodexMetadata: false,
	},
];

const packOutput = execFileSync("pnpm", ["pack", "--json", "--pack-destination", destination], {
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

const packResult = parsePackOutput(packOutput);
const tarball =
	packResult.filename ?? join(destination, `${packageJson.name}-${packageJson.version}.tgz`);
const entries = execFileSync("tar", ["-tzf", tarball], {
	encoding: "utf8",
	maxBuffer: 32 * 1024 * 1024,
})
	.split("\n")
	.filter(Boolean);

const requiredEntries = [
	"package/package.json",
	"package/README.md",
	"package/CHANGELOG.md",
	"package/LICENSE",
	"package/dist/cli.js",
	"package/assets/harness/manifest.json",
	`package/assets/harness/${canonicalInstructionPath}`,
	...canonicalContextModulePaths.map((path) => `package/assets/harness/${path}`),
	...canonicalSkillEntries.map((skill) => `package/assets/harness/${skill.path}/SKILL.md`),
];

const forbiddenPathPatterns = [
	/^package\/\.git(?:\/|$)/,
	/^package\/\.env(?:\.|$)/,
	/^package\/\.npmrc$/,
	/^package\/docs(?:\/|$)/,
	/^package\/\.firecrawl(?:\/|$)/,
	/(?:^|\/)id_rsa$/,
	/(?:^|\/)id_ed25519$/,
	/\.pem$/,
	/\.key$/,
];
const smokeTextExtensions = new Set([".json", ".md", ".sh", ".txt", ".yaml", ".yml"]);

const localPathPatterns = [homedir(), root]
	.filter((value) => value && value !== "/" && value.length > 1)
	.map((value) => new RegExp(escapeRegExp(value)));

const forbiddenContentPatterns = [
	...localPathPatterns,
	/BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/,
	/npm_[A-Za-z0-9]{20,}/,
	/gh[pousr]_[A-Za-z0-9_]{20,}/,
	/ctx7sk-[A-Za-z0-9-]{20,}/,
	/scripts\/init-do-flow\.sh/,
	/\.agentic-flow/,
	/docs\/agents\//,
	/scripts\/resolve-contract\.sh/,
	/contract\.json/,
	/verify_dev/,
	/\/signals\b/,
	/src\/server/,
	/src\/client/,
	/src\/client-v2/,
	/src\/shared\/domain\.ts/,
	/drizzle\/\*\.sql/,
	/\btRPC\b/i,
	/React Query/i,
	/shadcn/i,
	/localhost:5173/,
	/HAS_CLIENT_CHANGES/,
	/VITE_PORT/,
	/VITE_V2_PORT/,
	/Knowledge Graph/i,
	/\bKG\b/,
	/KG_CONTEXT/,
	/mcp__knowledge-graph/,
	/kg_search/,
	/kg_node/,
	/kg_neighbors/,
	/Anthropic best practices/i,
	/claude-opus/i,
	/claude-sonnet/i,
	/claude-haiku/i,
	/\.paveda\//i,
	/skills\.sh/,
];
const blockedContentFragments = [
	[0x6f, 0x75, 0x72, 0x6f, 0x62, 0x6f, 0x72, 0x6f, 0x73],
	[0xc9c1, 0xc811, 0x20, 0xcc28, 0xc6a9],
	[0xcc28, 0xc6a9],
	[0xcc38, 0xace0],
	[0x62, 0x6f, 0x72, 0x72, 0x6f, 0x77, 0x65, 0x64],
	[0x62, 0x6f, 0x72, 0x72, 0x6f, 0x77, 0x69, 0x6e, 0x67],
	[0x69, 0x6e, 0x73, 0x70, 0x69, 0x72, 0x65, 0x64],
	[0x69, 0x6e, 0x73, 0x70, 0x69, 0x72, 0x61, 0x74, 0x69, 0x6f, 0x6e],
	[0x70, 0x72, 0x6f, 0x76, 0x65, 0x6e, 0x61, 0x6e, 0x63, 0x65],
	[0x70, 0x72, 0x69, 0x6f, 0x72, 0x20, 0x61, 0x72, 0x74],
	[
		0x72, 0x69, 0x64, 0x65, 0x2d, 0x61, 0x69, 0x2d, 0x6d, 0x6f, 0x6e, 0x69, 0x74, 0x6f, 0x72, 0x69,
		0x6e, 0x67,
	],
	[
		0x72, 0x69, 0x64, 0x65, 0x20, 0x61, 0x69, 0x20, 0x6d, 0x6f, 0x6e, 0x69, 0x74, 0x6f, 0x72, 0x69,
		0x6e, 0x67,
	],
	[
		0x6b, 0x6e, 0x6f, 0x77, 0x6c, 0x65, 0x64, 0x67, 0x65, 0x2d, 0x76, 0x61, 0x75, 0x6c, 0x74, 0x73,
		0x2f, 0x72, 0x69, 0x64, 0x65,
	],
	[0x72, 0x69, 0x64, 0x65, 0x2d, 0x68, 0x61, 0x72, 0x6e, 0x65, 0x73, 0x73],
	[0x72, 0x69, 0x64, 0x65, 0x2d, 0x64, 0x65, 0x76, 0x65, 0x6c, 0x6f, 0x70, 0x65, 0x72],
	[
		0x65, 0x76, 0x65, 0x72, 0x79, 0x74, 0x68, 0x69, 0x6e, 0x67, 0x2d, 0x63, 0x6c, 0x61, 0x75, 0x64,
		0x65, 0x2d, 0x63, 0x6f, 0x64, 0x65,
	],
	[0x73, 0x75, 0x70, 0x65, 0x72, 0x63, 0x6c, 0x61, 0x75, 0x64, 0x65],
	[0x74, 0x61, 0x73, 0x6b, 0x2d, 0x6d, 0x61, 0x73, 0x74, 0x65, 0x72],
	[0x72, 0x75, 0x66, 0x6c, 0x6f],
	[
		0x72, 0x65, 0x73, 0x65, 0x61, 0x72, 0x63, 0x68, 0x20, 0x72, 0x65, 0x63, 0x6f, 0x6d, 0x6d, 0x65,
		0x6e, 0x64, 0x61, 0x74, 0x69, 0x6f, 0x6e,
	],
	[0x69, 0x6d, 0x70, 0x6f, 0x72, 0x74, 0x65, 0x64, 0x20, 0x73, 0x70, 0x65, 0x63],
	[0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x20, 0x73, 0x70, 0x65, 0x63],
	[0x73, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20, 0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74],
	[0x66, 0x72, 0x6f, 0x6d, 0x20, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e],
	[0x73, 0x6f, 0x75, 0x72, 0x63, 0x65, 0x20, 0x6f, 0x66, 0x20, 0x74, 0x72, 0x75, 0x74, 0x68],
	[0x61, 0x70, 0x70, 0x73, 0x2f, 0x61, 0x70, 0x69],
	[0x61, 0x70, 0x70, 0x73, 0x2f, 0x77, 0x65, 0x62],
	[0x70, 0x61, 0x63, 0x6b, 0x61, 0x67, 0x65, 0x73, 0x2f, 0x74, 0x79, 0x70, 0x65, 0x73],
	[0x2e, 0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x2d, 0x70],
	[0x63, 0x6f, 0x64, 0x65, 0x78, 0x2d, 0x63, 0x6f, 0x6d, 0x70, 0x61, 0x6e, 0x69, 0x6f, 0x6e],
	[0x63, 0x6c, 0x61, 0x75, 0x64, 0x65, 0x2d, 0x70],
	[
		0x2f, 0x76, 0x65, 0x72, 0x63, 0x65, 0x6c, 0x2d, 0x72, 0x65, 0x61, 0x63, 0x74, 0x2d, 0x62, 0x65,
		0x73, 0x74, 0x2d, 0x70, 0x72, 0x61, 0x63, 0x74, 0x69, 0x63, 0x65, 0x73,
	],
	[0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x2d, 0x73, 0x74, 0x61, 0x74, 0x73],
];
const blockedWordFragments = [
	[0x62, 0x6d, 0x61, 0x64],
	[0x6f, 0x6d, 0x63],
	[0x6f, 0x6d, 0x78],
	[0x65, 0x63, 0x63],
];

const missing = requiredEntries.filter((entry) => !entries.includes(entry));
if (missing.length > 0) {
	fail(`missing package entries:\n${missing.map((entry) => `- ${entry}`).join("\n")}`);
}

const forbiddenEntries = entries.filter((entry) =>
	forbiddenPathPatterns.some((pattern) => pattern.test(entry)),
);
if (forbiddenEntries.length > 0) {
	fail(`forbidden package entries:\n${forbiddenEntries.map((entry) => `- ${entry}`).join("\n")}`);
}

const content = execFileSync("tar", ["-xOzf", tarball], {
	encoding: "utf8",
	maxBuffer: 128 * 1024 * 1024,
});
const contentMatches = forbiddenContentPatterns
	.map((pattern) => [pattern, content.match(pattern)])
	.filter(([, match]) => Boolean(match));
const normalizedContent = content.toLocaleLowerCase("en-US");
const blockedFragmentMatches = blockedContentFragments
	.map((fragment, index) => [index, toText(fragment)])
	.filter(([, fragment]) => normalizedContent.includes(fragment));
const blockedWordMatches = blockedWordFragments
	.map((fragment, index) => [index, toText(fragment)])
	.filter(([, fragment]) => new RegExp(`\\b${escapeRegExp(fragment)}\\b`).test(normalizedContent));
if (
	contentMatches.length > 0 ||
	blockedFragmentMatches.length > 0 ||
	blockedWordMatches.length > 0
) {
	fail(
		`forbidden package content:\n${[
			...contentMatches.map(([pattern]) => `- ${pattern}`),
			...blockedFragmentMatches.map(([index]) => `- blocked-fragment-${index}`),
			...blockedWordMatches.map(([index]) => `- blocked-word-${index}`),
		].join("\n")}`,
	);
}

await runCliSmoke(tarball);

console.log(`package check ok: ${tarball}`);

function parsePackOutput(output) {
	if (!output.trim()) {
		return {};
	}

	const jsonStart = output.indexOf("{");
	const jsonEnd = output.lastIndexOf("}");
	if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
		fail("could not parse pnpm pack JSON output");
	}

	const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
	return Array.isArray(parsed) ? parsed[0] : parsed;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function toText(codePoints) {
	return String.fromCodePoint(...codePoints);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCanonicalInstructionPath(manifest) {
	if (typeof manifest?.instructions?.path !== "string" || !manifest.instructions.path) {
		fail("assets/harness/manifest.json is missing instructions.path");
	}

	return manifest.instructions.path;
}

function readCanonicalContextModulePaths(manifest) {
	if (!Array.isArray(manifest?.contextModules)) {
		fail("assets/harness/manifest.json is missing contextModules[]");
	}

	const paths = manifest.contextModules.map((module) => module?.path).filter(Boolean);
	if (paths.length !== manifest.contextModules.length) {
		fail("assets/harness/manifest.json contains a context module without a path");
	}

	return paths;
}

function readCanonicalSkillEntries(manifest) {
	if (!Array.isArray(manifest?.skills)) {
		fail("assets/harness/manifest.json is missing skills[]");
	}

	const skills = manifest.skills.map((skill) => ({
		name: skill?.name,
		path: skill?.path,
		optional: Boolean(skill?.optional),
	}));
	const missingName = skills.some((skill) => typeof skill.name !== "string" || !skill.name);
	if (missingName) {
		fail("assets/harness/manifest.json contains a skill without a name");
	}
	const missingPath = skills.some((skill) => typeof skill.path !== "string" || !skill.path);
	if (missingPath) {
		fail("assets/harness/manifest.json contains a skill without a path");
	}

	return skills;
}

async function runCliSmoke(tarballPath) {
	const smokeRoot = mkdtempSync(join(tmpdir(), "paveda-package-smoke-"));
	try {
		execFileSync("tar", ["-xzf", tarballPath, "-C", smokeRoot], {
			stdio: ["ignore", "ignore", "inherit"],
		});

		const packageRoot = join(smokeRoot, "package");
		const cliPath = join(packageRoot, "dist", "cli.js");

		assertFile(cliPath);
		assertPackagedVersion(packageRoot);
		assertPackagedHookLibraryApi(packageRoot);
		assertPackagedEventStoreLibraryApi(packageRoot, join(smokeRoot, "library-api-store.db"));
		assertPackagedProjectExtensionGuards(packageRoot);
		assertPackagedSkillIdentities(packageRoot, canonicalSkillEntries);
		assertPackagedBuiltinSkillInstall(cliPath, join(smokeRoot, "builtin-skill-install"));
		assertPackagedEnableRouterCommand(cliPath, join(smokeRoot, "enable-router-command"));
		assertPackagedPortCommand(cliPath);
		assertPackagedPolicyBundleCommand(cliPath, join(smokeRoot, "policy-bundle-command"));
		assertPackagedProjectCheckCommand(cliPath, join(smokeRoot, "project-check-command"));
		await assertPackagedConcurrentRouteCommands(
			cliPath,
			join(smokeRoot, "concurrent-route-project"),
		);
		const help = runCli(cliPath, ["help"]);
		assertIncludes(help, "Common flow:");
		assertIncludes(help, "Host setup:");
		assertIncludes(help, "adoption-report --host");
		assertIncludes(help, "skills install-bundle --host");
		assertIncludes(help, "runtime-smoke");
		assertIncludes(help, "policy bundle");
		assertIncludes(help, "policy pull");
		assertIncludes(help, "--policy-cache path");
		assertIncludes(help, "--store-scope project|user");
		assertIncludes(help, "instincts add --scope");
		assertIncludes(help, "Commands that can write project files require --write.");
		assertPackagedClaudeInstallUsesCurrentCli(
			cliPath,
			join(smokeRoot, "claude-install-current-cli"),
		);
		assertPackagedClaudeDoctorRefusesSettingsSymlink(
			cliPath,
			join(smokeRoot, "claude-doctor-settings-symlink"),
		);
		assertPackagedClaudeInitPreflightsSettings(
			cliPath,
			join(smokeRoot, "claude-init-settings-symlink"),
		);
		assertPackagedRecoveryQuotesCurrentCliPath(
			packageRoot,
			smokeRoot,
			join(smokeRoot, "recovery project with spaces"),
		);

		const skills = parseJson(runCli(cliPath, ["skills"]), "skills output");
		assertSkillNames(skills, canonicalSkillNames);
		const unknownSkillsCommand = runCliResult(cliPath, ["skills", "bogus"]);
		if (
			unknownSkillsCommand.status !== 1 ||
			!unknownSkillsCommand.stderr.includes("Unknown skills command: bogus")
		) {
			fail(
				`packaged CLI smoke failed: unknown skills subcommand did not fail clearly\n${unknownSkillsCommand.stderr}`,
			);
		}
		const invalidEnableRouter = runCliResult(cliPath, ["skills", "enable-router", "review"]);
		if (
			invalidEnableRouter.status !== 1 ||
			!invalidEnableRouter.stderr.includes("PAL Router metadata is only supported for /do")
		) {
			fail(
				`packaged CLI smoke failed: enable-router allowed a non-/do skill\n${invalidEnableRouter.stderr}`,
			);
		}
		const unknownCommandProject = join(smokeRoot, "unknown-command-project");
		const unknownCommand = runCliResult(cliPath, [
			"unknown-command",
			"--cwd",
			unknownCommandProject,
		]);
		if (
			unknownCommand.status !== 1 ||
			!unknownCommand.stderr.includes("Unknown command: unknown-command")
		) {
			fail(
				`packaged CLI smoke failed: unknown command did not fail clearly\n${unknownCommand.stderr}`,
			);
		}
		assertMissingFile(smokePath(unknownCommandProject, ".harness", "store.db"));
		assertNoStoreOnCliFailure(
			cliPath,
			["status", "--cwd", join(smokeRoot, "invalid-status-project"), "--status", "bogus"],
			"Invalid --status value: bogus",
			join(smokeRoot, "invalid-status-project"),
			"invalid status",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["status", "--cwd", join(smokeRoot, "invalid-store-scope-project"), "--store-scope", "bogus"],
			"Invalid --store-scope value: bogus",
			join(smokeRoot, "invalid-store-scope-project"),
			"invalid store scope",
		);
		assertNoStoreOnSymlinkWriteFailure(
			cliPath,
			"status",
			join(smokeRoot, "invalid-status-write-project"),
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["events", "--cwd", join(smokeRoot, "missing-session-project")],
			"Missing required option: --session",
			join(smokeRoot, "missing-session-project"),
			"events missing session",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"events",
				"--cwd",
				join(smokeRoot, "invalid-events-since-project"),
				"--session",
				"preflight-session",
				"--since",
				"bogus",
			],
			"Invalid --since value: bogus",
			join(smokeRoot, "invalid-events-since-project"),
			"events invalid since",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["router-trace", "--cwd", join(smokeRoot, "missing-router-trace-session-project")],
			"Missing required option: --session",
			join(smokeRoot, "missing-router-trace-session-project"),
			"router-trace missing session",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"router-trace",
				"--cwd",
				join(smokeRoot, "invalid-router-trace-since-project"),
				"--session",
				"preflight-session",
				"--since",
				"bogus",
			],
			"Invalid --since value: bogus",
			join(smokeRoot, "invalid-router-trace-since-project"),
			"router-trace invalid since",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"export-decisions",
				"--cwd",
				join(smokeRoot, "invalid-export-decisions-limit-project"),
				"--limit",
				"0",
			],
			"--limit must be a positive integer",
			join(smokeRoot, "invalid-export-decisions-limit-project"),
			"invalid export-decisions limit",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["instincts", "add", "--cwd", join(smokeRoot, "invalid-instinct-project")],
			"Missing required option: --scope",
			join(smokeRoot, "invalid-instinct-project"),
			"instinct add missing scope",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"--cwd",
				join(smokeRoot, "invalid-instinct-list-scope-project"),
				"--scope",
				"bogus",
			],
			"Invalid instinct scope: bogus",
			join(smokeRoot, "invalid-instinct-list-scope-project"),
			"instinct list invalid scope",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"--cwd",
				join(smokeRoot, "invalid-instinct-list-status-project"),
				"--status",
				"bogus",
			],
			"Invalid instinct status: bogus",
			join(smokeRoot, "invalid-instinct-list-status-project"),
			"instinct list invalid status",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"--cwd",
				join(smokeRoot, "invalid-instinct-list-limit-project"),
				"--limit",
				"0",
			],
			"--limit must be a positive integer",
			join(smokeRoot, "invalid-instinct-list-limit-project"),
			"instinct list invalid limit",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"add",
				"--cwd",
				join(smokeRoot, "invalid-instinct-confidence-project"),
				"--scope",
				"project",
				"--pattern",
				"Bad confidence",
				"--confidence",
				"2",
			],
			"--confidence must be between 0 and 1",
			join(smokeRoot, "invalid-instinct-confidence-project"),
			"instinct add invalid confidence",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"add",
				"--cwd",
				join(smokeRoot, "invalid-instinct-json-project"),
				"--scope",
				"project",
				"--pattern",
				"Bad examples",
				"--confidence",
				"0.5",
				"--examples-json",
				"{",
			],
			"--examples-json must be valid JSON",
			join(smokeRoot, "invalid-instinct-json-project"),
			"instinct add invalid examples json",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["instincts", "set-status", "--cwd", join(smokeRoot, "missing-instinct-id-project")],
			"Missing required option: --id",
			join(smokeRoot, "missing-instinct-id-project"),
			"instinct set-status missing id",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"set-status",
				"--cwd",
				join(smokeRoot, "invalid-instinct-id-project"),
				"--id",
				"0",
				"--status",
				"active",
			],
			"--id must be a positive integer",
			join(smokeRoot, "invalid-instinct-id-project"),
			"instinct set-status invalid id",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"instincts",
				"set-status",
				"--cwd",
				join(smokeRoot, "invalid-instinct-set-status-project"),
				"--id",
				"1",
				"--status",
				"bogus",
			],
			"Invalid instinct status: bogus",
			join(smokeRoot, "invalid-instinct-set-status-project"),
			"instinct set-status invalid status",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["route", "--cwd", join(smokeRoot, "invalid-route-project"), "--result", "bogus"],
			"Invalid router result: bogus",
			join(smokeRoot, "invalid-route-project"),
			"invalid route result",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["route", "--cwd", join(smokeRoot, "invalid-route-host-project"), "--host", "bogus"],
			"Unsupported skill bundle host: bogus",
			join(smokeRoot, "invalid-route-host-project"),
			"invalid route host",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["route", "--cwd", join(smokeRoot, "invalid-route-skill-project"), "--skill", "review"],
			"PAL Router is only enabled for /do",
			join(smokeRoot, "invalid-route-skill-project"),
			"invalid route skill",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["route", "--cwd", join(smokeRoot, "invalid-route-retries-project"), "--tool-retries", "-1"],
			"--tool-retries must be a non-negative integer",
			join(smokeRoot, "invalid-route-retries-project"),
			"invalid route retries",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"route",
				"--cwd",
				join(smokeRoot, "invalid-route-ambiguity-project"),
				"--ambiguity-score",
				"not-a-number",
			],
			"--ambiguity-score must be a number",
			join(smokeRoot, "invalid-route-ambiguity-project"),
			"invalid route ambiguity score",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"export-decisions",
				"--cwd",
				join(smokeRoot, "invalid-export-decisions-skill-project"),
				"--skill",
				"review",
			],
			"PAL Router is only enabled for /do",
			join(smokeRoot, "invalid-export-decisions-skill-project"),
			"invalid export-decisions skill",
		);
		assertNoStoreOnSymlinkWriteFailure(
			cliPath,
			"export-decisions",
			join(smokeRoot, "invalid-export-decisions-write-project"),
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["hook", "bogus", "--cwd", join(smokeRoot, "invalid-hook-project")],
			"Unsupported hook host: bogus",
			join(smokeRoot, "invalid-hook-project"),
			"invalid hook host",
		);
		assertNoStoreOnCliInputFailure(
			cliPath,
			["hook", "claude-code", "--cwd", join(smokeRoot, "invalid-hook-payload-project")],
			"[]",
			"Hook payload must be a JSON object",
			join(smokeRoot, "invalid-hook-payload-project"),
			"invalid hook payload",
		);
		assertNoStoreOnCliInputFailure(
			cliPath,
			["hook", "claude-code", "--cwd", join(smokeRoot, "missing-hook-session-project")],
			'{"hook_event_name":"Stop"}',
			"Claude Code hook payload is missing session_id",
			join(smokeRoot, "missing-hook-session-project"),
			"missing hook session",
		);
		assertNoStoreOnCliInputFailure(
			cliPath,
			["hook", "claude-code", "--cwd", join(smokeRoot, "invalid-hook-env-project")],
			JSON.stringify({
				hook_event_name: "Stop",
				session_id: "invalid-hook-env-session",
			}),
			"Invalid PAVEDA_SESSION_START_CONTEXT: maybe",
			join(smokeRoot, "invalid-hook-env-project"),
			"invalid hook env",
			{ env: { PAVEDA_SESSION_START_CONTEXT: "maybe" } },
		);
		assertNoStoreOnCliFailure(
			cliPath,
			["runtime-smoke", "--cwd", join(smokeRoot, "missing-runtime-smoke-cwd-project")],
			"Runtime smoke cwd is not a directory",
			join(smokeRoot, "missing-runtime-smoke-cwd-project"),
			"runtime-smoke missing cwd",
		);
		assertNoStoreOnCliFailure(
			cliPath,
			[
				"runtime-smoke",
				"--cwd",
				join(smokeRoot, "invalid-runtime-smoke-scope-project"),
				"--store-scope",
				"bogus",
			],
			"Invalid --store-scope value: bogus",
			join(smokeRoot, "invalid-runtime-smoke-scope-project"),
			"runtime-smoke invalid store scope",
		);
		const invalidRuntimeSmokeEnvProject = join(smokeRoot, "invalid-runtime-smoke-env-project");
		mkdirSync(invalidRuntimeSmokeEnvProject, { recursive: true });
		assertNoStoreOnCliFailure(
			cliPath,
			["runtime-smoke", "--cwd", invalidRuntimeSmokeEnvProject],
			"Invalid PAVEDA_SESSION_START_CONTEXT: maybe",
			invalidRuntimeSmokeEnvProject,
			"runtime-smoke invalid env",
			{ env: { PAVEDA_SESSION_START_CONTEXT: "maybe" } },
		);
		assertPackagedHookRuntime(
			cliPath,
			join(smokeRoot, "hook-runtime-store.db"),
			join(smokeRoot, "hook-runtime-project"),
		);
		assertPackagedRuntimeSmokeCommand(
			cliPath,
			join(smokeRoot, "runtime-smoke-store.db"),
			join(smokeRoot, "runtime-smoke-project"),
		);
		assertPackagedInstinctsCli(cliPath, join(smokeRoot, "instincts-store.db"));

		for (const hostCase of hostSmokeMatrix) {
			const projectRoot = join(smokeRoot, `project-${hostCase.host}`);
			assertPackagedHostInit(cliPath, projectRoot, hostCase);
			assertPackagedHostDoctor(cliPath, projectRoot, hostCase);
			assertPackagedAdoptionReport(cliPath, projectRoot, hostCase);
			if (hostCase.host === "codex") {
				assertPackagedRoute(cliPath, projectRoot, join(smokeRoot, "store.db"));
			}
		}
		assertPackagedAdoptionReportFailureDetails(
			cliPath,
			join(smokeRoot, "adoption-report-missing-codex"),
		);
		for (const hostCase of hostSmokeMatrix) {
			const projectRoot = join(smokeRoot, `skills-cli-${hostCase.host}`);
			assertPackagedSkillsCli(cliPath, projectRoot, hostCase);
			assertPackagedHostDoctor(cliPath, projectRoot, hostCase);
		}
		assertPackagedCustomTargetRoot(
			cliPath,
			join(smokeRoot, "custom-target-codex"),
			hostSmokeMatrix.find((hostCase) => hostCase.host === "codex"),
			"custom/skills",
		);
		assertPackagedCustomTargetRoot(
			cliPath,
			join(smokeRoot, "custom-target-hermes"),
			hostSmokeMatrix.find((hostCase) => hostCase.host === "hermes"),
			"vendor/hermes-skills",
		);
		assertPackagedCustomTargetSkillScript(
			cliPath,
			join(smokeRoot, "custom-target-script-codex"),
			hostSmokeMatrix.find((hostCase) => hostCase.host === "codex"),
			"skills",
		);
	} finally {
		rmSync(smokeRoot, { recursive: true, force: true });
	}
}

function assertPackagedHookRuntime(cliPath, dbPath, projectRoot) {
	mkdirSync(projectRoot, { recursive: true });
	const payloadCwdProject = join(projectRoot, "payload-cwd-project");
	const launchCwd = join(projectRoot, "launch-cwd");
	mkdirSync(payloadCwdProject, { recursive: true });
	mkdirSync(launchCwd, { recursive: true });
	runCliWithInput(
		cliPath,
		["hook", "claude-code"],
		JSON.stringify({
			hook_event_name: "Stop",
			session_id: "packaged-payload-cwd-session",
			cwd: payloadCwdProject,
			stop_hook_active: false,
		}),
		{ cwd: launchCwd },
	);
	assertFile(smokePath(payloadCwdProject, ".harness", "store.db"));
	assertMissingFile(smokePath(launchCwd, ".harness", "store.db"));
	const payloadCwdSessions = parseJson(
		runCli(cliPath, ["status", "--cwd", payloadCwdProject]),
		"hook payload cwd status output",
	);
	if (
		!Array.isArray(payloadCwdSessions) ||
		!payloadCwdSessions.some(
			(session) =>
				session?.id === "packaged-payload-cwd-session" && session?.status === "completed",
		)
	) {
		fail("packaged CLI smoke failed: hook command did not use payload cwd for the default store");
	}
	const preToolUse = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-hook-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "pnpm test" },
			}),
		),
		"claude-code PreToolUse hook output",
	);
	if (preToolUse?.dispatched !== true || preToolUse?.hook?.name !== "harness.destructive.guard") {
		fail("packaged CLI smoke failed: PreToolUse hook was not dispatched through runtime");
	}
	const sessionStartConfigSnapshot = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "packaged-config-snapshot-session",
				cwd: projectRoot,
			}),
			{ env: { PAVEDA_HOOK_PROFILE: "standard" } },
		),
		"claude-code SessionStart config snapshot output",
	);
	if (sessionStartConfigSnapshot?.dispatched !== true) {
		fail("packaged CLI smoke failed: SessionStart did not create a config snapshot");
	}
	const agentAfterProfileChange = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PostToolUse",
				session_id: "packaged-config-snapshot-session",
				cwd: projectRoot,
				tool_name: "Agent",
				tool_response: { agentId: "agent-after-profile-change" },
			}),
			{ env: { PAVEDA_HOOK_PROFILE: "minimal" } },
		),
		"claude-code PostToolUse config snapshot output",
	);
	if (
		agentAfterProfileChange?.dispatched !== true ||
		agentAfterProfileChange?.hook?.name !== "harness.cost.guard"
	) {
		fail("packaged CLI smoke failed: hook profile was not frozen at session start");
	}
	const configSnapshotEvents = parseJson(
		runCli(cliPath, ["events", "--session", "packaged-config-snapshot-session", "--db", dbPath]),
		"config snapshot events output",
	);
	if (
		!Array.isArray(configSnapshotEvents) ||
		!configSnapshotEvents.some(
			(event) => event?.type === "config.snapshot" && event?.payload?.hookProfile === "standard",
		) ||
		!configSnapshotEvents.some((event) => event?.type === "cost.guard.evaluated")
	) {
		fail("packaged CLI smoke failed: config snapshot events were not recorded or reused");
	}
	const disabledSessionStartSnapshot = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "packaged-disabled-session-start-snapshot",
				cwd: projectRoot,
			}),
			{
				env: {
					PAVEDA_HOOK_PROFILE: "standard",
					PAVEDA_DISABLED_HOOKS: "session.created:session:harness.session.context",
				},
			},
		),
		"claude-code disabled SessionStart config snapshot output",
	);
	if (
		disabledSessionStartSnapshot?.dispatched !== false ||
		disabledSessionStartSnapshot?.events?.[0]?.type !== "config.snapshot"
	) {
		fail("packaged CLI smoke failed: disabled SessionStart did not preserve a config snapshot");
	}
	const agentAfterDisabledSessionStart = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PostToolUse",
				session_id: "packaged-disabled-session-start-snapshot",
				cwd: projectRoot,
				tool_name: "Agent",
				tool_response: { agentId: "agent-after-disabled-session-start" },
			}),
			{ env: { PAVEDA_HOOK_PROFILE: "minimal" } },
		),
		"claude-code disabled SessionStart frozen config output",
	);
	if (
		agentAfterDisabledSessionStart?.dispatched !== true ||
		agentAfterDisabledSessionStart?.hook?.name !== "harness.cost.guard"
	) {
		fail("packaged CLI smoke failed: disabled SessionStart snapshot was not reused");
	}
	const deniedEnvWrite = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-denied-env-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "printf 'DEBUG=1' > .env.local" },
			}),
		),
		"claude-code denied .env write hook output",
	);
	if (
		deniedEnvWrite?.hookSpecificOutput?.permissionDecision !== "deny" ||
		!deniedEnvWrite.hookSpecificOutput.permissionDecisionReason.includes("D-001")
	) {
		fail("packaged CLI smoke failed: destructive guard did not deny direct .env writes");
	}
	const deniedRm = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-denied-rm-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "rm -rf /" },
			}),
		),
		"claude-code denied rm hook output",
	);
	if (
		deniedRm?.hookSpecificOutput?.permissionDecision !== "deny" ||
		!deniedRm.hookSpecificOutput.permissionDecisionReason.includes("D-003")
	) {
		fail("packaged CLI smoke failed: destructive guard did not deny high-risk rm");
	}
	const deniedKeyWrite = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-denied-key-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "openssl genrsa -out private.key 4096" },
			}),
		),
		"claude-code denied key file hook output",
	);
	if (
		deniedKeyWrite?.hookSpecificOutput?.permissionDecision !== "deny" ||
		!deniedKeyWrite.hookSpecificOutput.permissionDecisionReason.includes("D-005")
	) {
		fail("packaged CLI smoke failed: destructive guard did not deny key file writes");
	}
	const deniedCodexEnvWrite = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "codex", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-codex-denied-env-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "printf 'DEBUG=1' > .env.local" },
			}),
		),
		"codex denied .env write hook output",
	);
	if (
		deniedCodexEnvWrite?.hookSpecificOutput?.permissionDecision !== "deny" ||
		!deniedCodexEnvWrite.hookSpecificOutput.permissionDecisionReason.includes("D-001")
	) {
		fail("packaged CLI smoke failed: Codex hook response did not deny direct .env writes");
	}
	const deniedHermesRm = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "hermes", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "pre_tool_call",
				session_id: "packaged-hermes-denied-rm-session",
				cwd: projectRoot,
				tool_name: "terminal",
				tool_input: { command: "rm -rf /" },
			}),
		),
		"hermes denied rm hook output",
	);
	if (
		deniedHermesRm?.action !== "block" ||
		deniedHermesRm?.decision !== "block" ||
		!deniedHermesRm.reason.includes("D-003")
	) {
		fail("packaged CLI smoke failed: Hermes hook response did not block high-risk rm");
	}
	const deniedPiEnvWrite = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "pi", "--db", dbPath],
			JSON.stringify({
				event_name: "tool_call",
				session_id: "packaged-pi-denied-env-session",
				cwd: projectRoot,
				toolName: "write",
				input: { path: ".env.local", content: "DEBUG=1" },
			}),
		),
		"pi denied .env write hook output",
	);
	if (deniedPiEnvWrite?.block !== true || !deniedPiEnvWrite.reason.includes("D-004")) {
		fail("packaged CLI smoke failed: Pi hook response did not block direct .env writes");
	}
	const warnedChmod = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "packaged-warned-chmod-session",
				cwd: projectRoot,
				tool_name: "Bash",
				tool_input: { command: "chmod a+w shared" },
			}),
		),
		"claude-code warned chmod hook output",
	);
	if (
		warnedChmod?.hookSpecificOutput?.additionalContext === undefined ||
		!warnedChmod.hookSpecificOutput.additionalContext.includes("D-006")
	) {
		fail("packaged CLI smoke failed: destructive guard did not warn for world-writable chmod");
	}

	const stop = parseJson(
		runCliWithInput(
			cliPath,
			["hook", "claude-code", "--db", dbPath],
			JSON.stringify({
				hook_event_name: "Stop",
				session_id: "packaged-hook-session",
				stop_hook_active: false,
			}),
		),
		"claude-code Stop hook output",
	);
	if (stop?.dispatched !== true || stop?.hook?.name !== "paveda.lifecycle.session.stop") {
		fail("packaged CLI smoke failed: Stop hook was not dispatched through runtime");
	}

	const events = parseJson(
		runCli(cliPath, ["events", "--session", "packaged-hook-session", "--db", dbPath]),
		"hook events output",
	);
	assertEventTypes(events, [
		"hook.fired",
		"tool.execute.before",
		"destructive.guard.evaluated",
		"tooling.enforce.evaluated",
		"hook.fired",
		"session.completed",
	]);
	const futureEvents = parseJson(
		runCli(cliPath, [
			"events",
			"--session",
			"packaged-hook-session",
			"--db",
			dbPath,
			"--since",
			"9999-01-01T00:00:00.000Z",
		]),
		"hook events future-since output",
	);
	if (!Array.isArray(futureEvents) || futureEvents.length !== 0) {
		fail("packaged CLI smoke failed: events --since did not filter future events");
	}

	const sessions = parseJson(runCli(cliPath, ["status", "--db", dbPath]), "hook status output");
	const summary = Array.isArray(sessions)
		? sessions.find((session) => session?.id === "packaged-hook-session")
		: undefined;
	if (summary?.status !== "completed" || summary?.toolCalls !== 1) {
		fail("packaged CLI smoke failed: hook session summary was not materialized");
	}

	const statusMarkdownPath = join(projectRoot, "paveda-status.md");
	runCli(cliPath, ["status", "--db", dbPath, "--markdown", "--write", statusMarkdownPath]);
	assertFile(statusMarkdownPath);
	const statusMarkdown = readFileSync(statusMarkdownPath, "utf8");
	assertIncludes(statusMarkdown, "# Paveda Session Status");
	assertIncludes(statusMarkdown, "packaged-hook-session");
	const externalStatusPath = join(projectRoot, "external-status.md");
	const linkedStatusPath = join(projectRoot, "linked-status.md");
	writeFileSync(externalStatusPath, "external status\n");
	symlinkSync(externalStatusPath, linkedStatusPath);
	const symlinkStatusWrite = runCliResult(cliPath, [
		"status",
		"--db",
		dbPath,
		"--write",
		linkedStatusPath,
	]);
	if (
		symlinkStatusWrite.status !== 1 ||
		!symlinkStatusWrite.stderr.includes("Output path must not use symlinks")
	) {
		fail(
			`packaged CLI smoke failed: status --write accepted a symlink path\n${symlinkStatusWrite.stderr}`,
		);
	}
	if (readFileSync(externalStatusPath, "utf8") !== "external status\n") {
		fail("packaged CLI smoke failed: status --write modified a symlink target");
	}

	const failedSessionId = "packaged-failed-session";
	seedFailedSession(cliPath, dbPath, failedSessionId);
	const failedSessions = parseJson(
		runCli(cliPath, ["status", "--db", dbPath, "--status", "failed"]),
		"failed status output",
	);
	if (
		!Array.isArray(failedSessions) ||
		!failedSessions.some((session) => session?.id === failedSessionId && session?.costUsd === 1.25)
	) {
		fail("packaged CLI smoke failed: status --status failed did not include failed session");
	}
	assertCliExitCode(
		cliPath,
		["status", "--db", dbPath, "--status", "failed", "--exit-code"],
		1,
		"failed status exit-code",
	);
	const invalidStatus = runCliResult(cliPath, ["status", "--db", dbPath, "--status", "bogus"]);
	if (
		invalidStatus.status !== 1 ||
		!invalidStatus.stderr.includes("Invalid --status value: bogus")
	) {
		fail(
			`packaged CLI smoke failed: invalid status did not fail with a clear error\n${invalidStatus.stderr}`,
		);
	}
	const missingWritePath = runCliResult(cliPath, ["status", "--db", dbPath, "--write"]);
	if (
		missingWritePath.status !== 1 ||
		!missingWritePath.stderr.includes("Missing value for option: --write")
	) {
		fail(
			`packaged CLI smoke failed: missing --write value did not fail clearly\n${missingWritePath.stderr}`,
		);
	}
	const flagAsDbPath = runCliResult(cliPath, ["status", "--db", "--status", "failed"]);
	if (
		flagAsDbPath.status !== 1 ||
		!flagAsDbPath.stderr.includes("Missing value for option: --db")
	) {
		fail(
			`packaged CLI smoke failed: flag after --db was accepted as a value\n${flagAsDbPath.stderr}`,
		);
	}
}

function assertPackagedRuntimeSmokeCommand(cliPath, dbPath, projectRoot) {
	mkdirSync(projectRoot, { recursive: true });
	const result = parseJson(
		runCli(cliPath, [
			"runtime-smoke",
			"--cwd",
			projectRoot,
			"--db",
			dbPath,
			"--session",
			"packaged-runtime-smoke-session",
			"--json",
		]),
		"runtime-smoke output",
	);

	if (result?.ok !== true || result?.summary?.status !== "completed") {
		fail("packaged CLI smoke failed: runtime-smoke did not complete successfully");
	}

	assertEventTypes(result?.eventTypes, [
		"hook.fired",
		"config.snapshot",
		"session.created",
		"hook.fired",
		"tool.execute.before",
		"destructive.guard.evaluated",
		"tooling.enforce.evaluated",
		"hook.fired",
		"session.completed",
	]);

	const userScopeProject = join(projectRoot, "user-scope-project");
	const userScopeHome = join(projectRoot, "user-scope-home");
	mkdirSync(userScopeProject, { recursive: true });
	mkdirSync(userScopeHome, { recursive: true });
	const userScope = parseJson(
		runCliWithEnv(
			cliPath,
			[
				"runtime-smoke",
				"--cwd",
				userScopeProject,
				"--store-scope",
				"user",
				"--session",
				"packaged-runtime-smoke-user-scope",
				"--json",
			],
			{ HOME: userScopeHome },
		),
		"runtime-smoke user-scope output",
	);
	const userScopeDbPath = join(userScopeHome, ".harness", "store.db");
	if (userScope?.ok !== true || userScope?.dbPath !== userScopeDbPath) {
		fail("packaged CLI smoke failed: runtime-smoke --store-scope user used the wrong store");
	}
	assertFile(userScopeDbPath);
	assertMissingFile(smokePath(userScopeProject, ".harness", "store.db"));
	const userScopeStatus = parseJson(
		runCliWithEnv(cliPath, ["status", "--store-scope", "user"], { HOME: userScopeHome }),
		"status user-scope output",
	);
	if (
		!Array.isArray(userScopeStatus) ||
		!userScopeStatus.some((session) => session?.id === "packaged-runtime-smoke-user-scope")
	) {
		fail("packaged CLI smoke failed: status --store-scope user did not read the user store");
	}
}

function assertPackagedInstinctsCli(cliPath, dbPath) {
	const added = parseJson(
		runCli(cliPath, [
			"instincts",
			"add",
			"--db",
			dbPath,
			"--scope",
			"project",
			"--pattern",
			"Run focused checks before broad checks",
			"--evidence",
			"Package smoke",
			"--examples-json",
			'[{"command":"pnpm test"}]',
			"--confidence",
			"0.82",
			"--status",
			"active",
		]),
		"instinct add output",
	);
	if (
		added?.scope !== "project" ||
		added?.status !== "active" ||
		added?.examples?.[0]?.command !== "pnpm test"
	) {
		fail("packaged CLI smoke failed: instincts add did not record the expected row");
	}

	const projectInstincts = parseJson(
		runCli(cliPath, ["instincts", "--db", dbPath, "--scope", "project", "--status", "active"]),
		"instinct list output",
	);
	if (!Array.isArray(projectInstincts) || projectInstincts[0]?.id !== added.id) {
		fail("packaged CLI smoke failed: instincts list did not return the added row");
	}

	const promoted = parseJson(
		runCli(cliPath, [
			"instincts",
			"set-status",
			"--db",
			dbPath,
			"--id",
			String(added.id),
			"--status",
			"promoted",
		]),
		"instinct set-status output",
	);
	if (promoted?.id !== added.id || promoted?.status !== "promoted") {
		fail("packaged CLI smoke failed: instincts set-status did not update the row");
	}

	const missing = runCliResult(cliPath, [
		"instincts",
		"set-status",
		"--db",
		dbPath,
		"--id",
		"999999",
		"--status",
		"active",
	]);
	if (missing.status !== 1 || !missing.stderr.includes("Instinct not found: 999999")) {
		fail(
			`packaged CLI smoke failed: instincts set-status missing row did not fail clearly\n${missing.stderr}`,
		);
	}
}

function assertPackagedHostInit(cliPath, projectRoot, hostCase) {
	const initArgs = ["init", "--host", hostCase.host, "--cwd", projectRoot, "--write", "--force"];
	if (hostCase.host === "claude-code") {
		initArgs.push("--cli-path", cliPath);
	}

	const init = parseJson(runCli(cliPath, initArgs), `${hostCase.host} init output`);
	if (!init?.doctor?.ok) {
		fail(`packaged CLI smoke failed: ${hostCase.host} init doctor result is not ok`);
	}
	assertInitNextCommand(init, "doctor");
	assertInitNextCommand(init, "skills-status");
	assertInitNextCommand(init, "route-do");
	assertInitNextCommand(init, "runtime-smoke");

	assertFile(smokePath(projectRoot, hostCase.instructionFile));
	assertIncludes(
		readFileSync(smokePath(projectRoot, hostCase.instructionFile), "utf8"),
		`- Workflow skills: \`${hostCase.skillRoot}\``,
	);
	for (const contextModulePath of canonicalContextModulePaths) {
		assertFile(smokePath(projectRoot, hostCase.contextRoot, basename(contextModulePath)));
	}
	if (hostCase.hermesConfigFile) {
		const configPath = smokePath(projectRoot, hostCase.hermesConfigFile);
		assertFile(configPath);
		assertIncludes(readFileSync(configPath, "utf8"), "    - .hermes/skills");
	}
	for (const skill of canonicalCoreSkillEntries) {
		const skillPath = smokePath(projectRoot, hostCase.skillRoot, skill.name, "SKILL.md");
		assertFile(skillPath);
		assertIncludes(readFileSync(skillPath, "utf8"), `name: ${skill.name}`);
		const codexMetadataPath = smokePath(
			projectRoot,
			hostCase.skillRoot,
			skill.name,
			"agents",
			"openai.yaml",
		);
		if (hostCase.createsCodexMetadata) {
			assertFile(codexMetadataPath);
		} else {
			assertMissingFile(codexMetadataPath);
		}
	}

	const doSkillText = readFileSync(
		smokePath(projectRoot, hostCase.skillRoot, "do", "SKILL.md"),
		"utf8",
	);
	assertIncludes(doSkillText, "router: enabled");
	assertIncludes(doSkillText, `${hostCase.skillRoot}/do/scripts/detect-stagnation.sh`);
	assertIncludes(doSkillText, `${hostCase.contextRoot}/backend-patterns.md`);
	if (hostCase.host !== "harness") {
		assertExcludes(doSkillText, ".harness/skills");
		assertExcludes(doSkillText, ".harness/context-modules");
		assertExcludes(doSkillText, ".harness/AGENTS.md");
	}
	assertRenderedHostTextPaths(projectRoot, hostCase);
	assertRenderedHostFrontmatter(projectRoot, hostCase);

	const plannerAgentText = readFileSync(
		smokePath(projectRoot, hostCase.skillRoot, "do", "agents", "planner.md"),
		"utf8",
	);
	if (hostCase.host === "harness") {
		assertIncludes(plannerAgentText, "model: frontier");
	} else if (hostCase.host === "claude-code") {
		assertIncludes(plannerAgentText, "model: opus");
	} else {
		assertExcludes(plannerAgentText, "model:");
	}
}

function assertRenderedHostTextPaths(projectRoot, hostCase) {
	const blockedFragments = [
		...(hostCase.host === "harness"
			? []
			: [".harness/skills", ".harness/context-modules", ".harness/AGENTS.md"]),
		...(hostCase.host === "claude-code"
			? []
			: [".claude/skills", ".claude/context-modules", ".claude/CLAUDE.md"]),
	];
	if (blockedFragments.length === 0) {
		return;
	}

	const scanRoots = [
		smokePath(projectRoot, hostCase.skillRoot),
		smokePath(projectRoot, hostCase.contextRoot),
		smokePath(projectRoot, hostCase.instructionFile),
	];
	const violations = scanRoots
		.flatMap((path) => scanSmokeTextFiles(path))
		.flatMap((path) => {
			const content = readFileSync(path, "utf8");
			return blockedFragments
				.filter((fragment) => content.includes(fragment))
				.map((fragment) => `${path}: ${fragment}`);
		});

	if (violations.length > 0) {
		fail(
			`packaged CLI smoke failed: ${hostCase.host} rendered stale host path references\n${violations
				.map((violation) => `- ${violation}`)
				.join("\n")}`,
		);
	}
}

function scanSmokeTextFiles(path) {
	if (!existsSync(path)) {
		return [];
	}

	const stats = statSync(path);
	if (stats.isFile()) {
		return isSmokeTextFile(path) ? [path] : [];
	}
	if (!stats.isDirectory()) {
		return [];
	}

	const entries = readdirSync(path, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const entryPath = join(path, entry.name);
		if (entry.isDirectory()) {
			return scanSmokeTextFiles(entryPath);
		}

		return entry.isFile() && isSmokeTextFile(entryPath) ? [entryPath] : [];
	});
}

function isSmokeTextFile(path) {
	return basename(path) === "SKILL.md" || smokeTextExtensions.has(extname(path));
}

function assertRenderedHostFrontmatter(projectRoot, hostCase) {
	const frontmatters = scanSmokeTextFiles(smokePath(projectRoot, hostCase.skillRoot))
		.map((path) => ({ path, frontmatter: extractFrontmatter(readFileSync(path, "utf8")) }))
		.filter((entry) => entry.frontmatter);
	const tierHintViolations = frontmatters
		.filter((entry) => hostCase.host !== "harness")
		.filter((entry) => /^model:\s*(frontier|standard|frugal)\s*$/m.test(entry.frontmatter))
		.map((entry) => entry.path);
	if (tierHintViolations.length > 0) {
		fail(
			`packaged CLI smoke failed: ${hostCase.host} rendered unadapted model tiers\n${tierHintViolations
				.map((path) => `- ${path}`)
				.join("\n")}`,
		);
	}

	const unsupportedModelViolations = frontmatters
		.filter((entry) => hostCase.host !== "harness" && hostCase.host !== "claude-code")
		.filter((entry) => /^model:\s*.+$/m.test(entry.frontmatter))
		.map((entry) => entry.path);
	if (unsupportedModelViolations.length > 0) {
		fail(
			`packaged CLI smoke failed: ${hostCase.host} rendered model frontmatter\n${unsupportedModelViolations
				.map((path) => `- ${path}`)
				.join("\n")}`,
		);
	}
}

function extractFrontmatter(content) {
	if (!content.startsWith("---\n")) {
		return "";
	}

	const end = content.indexOf("\n---", 4);
	return end === -1 ? "" : content.slice(4, end);
}

function assertPackagedHostDoctor(cliPath, projectRoot, hostCase) {
	const doctor = parseJson(
		runCli(cliPath, ["doctor", "--host", hostCase.host, "--cwd", projectRoot, "--json"]),
		`${hostCase.host} doctor output`,
	);
	if (!doctor?.ok) {
		fail(`packaged CLI smoke failed: ${hostCase.host} doctor result is not ok`);
	}
	if (hostCase.host === "codex") {
		assertCheckStatus(doctor, "host-codex-metadata", "pass");
	}
	if (hostCase.host === "hermes") {
		assertCheckStatus(doctor, "host-hermes-config", "pass");
	}
}

function assertPackagedAdoptionReport(cliPath, projectRoot, hostCase) {
	const args = [
		"adoption-report",
		"--host",
		hostCase.host,
		"--cwd",
		projectRoot,
		"--runtime-smoke",
		"--db",
		join(projectRoot, ".harness", "adoption-report-smoke.db"),
		"--session",
		`packaged-adoption-report-smoke-${hostCase.host}`,
		"--json",
	];

	const report = parseJson(runCli(cliPath, args), `${hostCase.host} adoption-report output`);
	if (report?.ok !== true) {
		fail(`packaged CLI smoke failed: ${hostCase.host} adoption report is not ok`);
	}
	if (report?.route?.reason !== "blocked:ambiguity") {
		fail(`packaged CLI smoke failed: ${hostCase.host} adoption report route check failed`);
	}
	if (report?.runtimeSmoke?.status !== "pass") {
		fail(`packaged CLI smoke failed: ${hostCase.host} adoption report runtime status failed`);
	}
}

function assertPackagedAdoptionReportFailureDetails(cliPath, projectRoot) {
	mkdirSync(projectRoot, { recursive: true });
	const result = runCliResult(cliPath, [
		"adoption-report",
		"--host",
		"codex",
		"--cwd",
		projectRoot,
		"--json",
	]);
	if (result.status !== 1) {
		fail("packaged CLI smoke failed: missing Codex adoption report did not fail");
	}

	const report = parseJson(result.stdout, "missing Codex adoption-report output");
	assertMissingFile(smokePath(projectRoot, ".harness", "store.db"));
	const doctor = Array.isArray(report?.checks)
		? report.checks.find((check) => check?.name === "doctor")
		: undefined;
	if (
		doctor?.status !== "fail" ||
		typeof doctor.message !== "string" ||
		!doctor.message.includes("host-skill-root")
	) {
		fail("packaged CLI smoke failed: adoption report doctor failure summary is incomplete");
	}

	const failures = doctor.details?.failures;
	const skillRootFailure = Array.isArray(failures)
		? failures.find((failure) => failure?.name === "host-skill-root")
		: undefined;
	const hasSkillRootFailure =
		typeof skillRootFailure?.message === "string" &&
		skillRootFailure.message.includes("Host skill root is missing.") &&
		skillRootFailure.path === smokePath(projectRoot, ".codex/skills") &&
		skillRootFailure.recovery?.command ===
			`node ${cliPath} skills install-bundle --host codex --cwd ${projectRoot} --write`;
	if (!hasSkillRootFailure) {
		fail(
			"packaged CLI smoke failed: adoption report doctor details are missing host-skill-root recovery",
		);
	}

	runPackagedRecoveryCommand(cliPath, projectRoot, skillRootFailure.recovery.command);
	const repairedDoctor = parseJson(
		runCli(cliPath, ["doctor", "--host", "codex", "--cwd", projectRoot, "--json"]),
		"repaired Codex doctor output",
	);
	if (repairedDoctor?.ok !== true) {
		fail("packaged CLI smoke failed: adoption report recovery command did not repair Codex host");
	}
}

function assertPackagedClaudeInstallUsesCurrentCli(cliPath, projectRoot) {
	const dryRunSettingsPath = smokePath(projectRoot, "dry-run", ".claude/settings.json");
	const dryRunExternalSettingsPath = smokePath(projectRoot, "dry-run-external-settings.json");
	mkdirSync(dirname(dryRunSettingsPath), { recursive: true });
	writeFileSync(dryRunExternalSettingsPath, '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
	symlinkSync(dryRunExternalSettingsPath, dryRunSettingsPath);
	const dryRunSymlink = runCliResult(cliPath, [
		"install",
		"claude-code",
		"--path",
		dryRunSettingsPath,
	]);
	if (
		dryRunSymlink.status !== 1 ||
		!dryRunSymlink.stderr.includes("Claude Code settings path must not use symlinks")
	) {
		fail(
			`packaged CLI smoke failed: Claude Code dry-run read symlinked settings\n${dryRunSymlink.stderr}`,
		);
	}
	if (
		dryRunSymlink.stdout.includes("PRIVATE_VALUE") ||
		dryRunSymlink.stderr.includes("PRIVATE_VALUE")
	) {
		fail("packaged CLI smoke failed: Claude Code dry-run exposed symlinked settings content");
	}
	if (
		readFileSync(dryRunExternalSettingsPath, "utf8") !==
		'{"env":{"PRIVATE_VALUE":"do-not-print"}}\n'
	) {
		fail("packaged CLI smoke failed: Claude Code dry-run modified a symlinked settings target");
	}

	const settingsPath = smokePath(projectRoot, ".claude/settings.json");
	const expectedCommand = `node ${cliPath} hook claude-code`;
	const result = parseJson(
		runCli(cliPath, [
			"install",
			"claude-code",
			"--path",
			settingsPath,
			"--session-start-context",
			"off",
			"--write",
		]),
		"claude-code current CLI install output",
	);
	if (result?.summary?.command !== expectedCommand) {
		fail("packaged CLI smoke failed: Claude Code installer did not use the current CLI command");
	}
	if (result?.summary?.env?.sessionStartContext !== "off") {
		fail("packaged CLI smoke failed: Claude Code installer did not report SessionStart context");
	}

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	if (settings?.env?.PAVEDA_CLI !== cliPath) {
		fail("packaged CLI smoke failed: Claude Code installer did not store the current CLI path");
	}
	if (settings?.env?.PAVEDA_SESSION_START_CONTEXT !== "off") {
		fail("packaged CLI smoke failed: Claude Code installer did not store SessionStart context");
	}

	const installedCommands = Object.values(settings?.hooks ?? {}).flatMap((matchers) =>
		matchers.flatMap((matcher) => matcher?.hooks ?? []).map((hook) => hook?.command),
	);
	if (installedCommands.filter((command) => command === expectedCommand).length !== 4) {
		fail("packaged CLI smoke failed: Claude Code hooks do not all use the current CLI command");
	}
}

function assertPackagedClaudeDoctorRefusesSettingsSymlink(cliPath, projectRoot) {
	const settingsPath = smokePath(projectRoot, ".claude/settings.json");
	const externalSettingsPath = smokePath(projectRoot, "external-settings.json");
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(externalSettingsPath, '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n');
	symlinkSync(externalSettingsPath, settingsPath);

	const result = runCliResult(cliPath, [
		"doctor",
		"--host",
		"claude-code",
		"--cwd",
		projectRoot,
		"--json",
	]);
	if (result.status !== 1) {
		fail("packaged CLI smoke failed: doctor accepted symlinked Claude Code settings");
	}
	if (result.stdout.includes("PRIVATE_VALUE") || result.stderr.includes("PRIVATE_VALUE")) {
		fail("packaged CLI smoke failed: doctor exposed symlinked Claude Code settings content");
	}

	const doctor = parseJson(result.stdout, "claude-code symlinked settings doctor output");
	const claudeHooks = Array.isArray(doctor?.checks)
		? doctor.checks.find((check) => check?.name === "claude-code-hooks")
		: undefined;
	if (
		claudeHooks?.status !== "fail" ||
		typeof claudeHooks.message !== "string" ||
		!claudeHooks.message.includes("Claude Code settings path must not use symlinks")
	) {
		fail("packaged CLI smoke failed: doctor did not report symlinked Claude Code settings");
	}
	if (readFileSync(externalSettingsPath, "utf8") !== '{"env":{"PRIVATE_VALUE":"do-not-print"}}\n') {
		fail("packaged CLI smoke failed: doctor modified a symlinked settings target");
	}
}

function assertPackagedClaudeInitPreflightsSettings(cliPath, projectRoot) {
	const settingsPath = smokePath(projectRoot, ".claude/settings.json");
	const externalSettingsPath = smokePath(projectRoot, "external-settings.json");
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(externalSettingsPath, "{}\n");
	symlinkSync(externalSettingsPath, settingsPath);

	const result = runCliResult(cliPath, [
		"init",
		"--host",
		"claude-code",
		"--cwd",
		projectRoot,
		"--cli-path",
		cliPath,
		"--write",
		"--force",
	]);
	if (
		result.status !== 1 ||
		!result.stderr.includes("Claude Code settings path must not use symlinks")
	) {
		fail(
			`packaged CLI smoke failed: claude-code init did not preflight symlinked settings\n${result.stderr}`,
		);
	}
	if (readFileSync(externalSettingsPath, "utf8") !== "{}\n") {
		fail("packaged CLI smoke failed: claude-code init modified a symlinked settings target");
	}
	assertMissingFile(smokePath(projectRoot, ".claude", "skills", "do", "SKILL.md"));
	assertMissingFile(smokePath(projectRoot, ".claude", "CLAUDE.md"));
	assertMissingFile(smokePath(projectRoot, ".claude", "context-modules", "backend-patterns.md"));
}

function assertPackagedRecoveryQuotesCurrentCliPath(packageRoot, smokeRoot, projectRoot) {
	const linkedParent = join(smokeRoot, "linked package parent with spaces");
	const linkedPackageRoot = join(linkedParent, "package");
	mkdirSync(linkedParent, { recursive: true });
	symlinkSync(packageRoot, linkedPackageRoot, "dir");
	const cliPath = join(linkedPackageRoot, "dist", "cli.js");
	const result = runCliResult(cliPath, [
		"adoption-report",
		"--host",
		"codex",
		"--cwd",
		projectRoot,
		"--json",
	]);
	if (result.status !== 1) {
		fail("packaged CLI smoke failed: quoted CLI recovery fixture did not fail before repair");
	}

	const report = parseJson(result.stdout, "quoted CLI adoption-report output");
	const doctor = Array.isArray(report?.checks)
		? report.checks.find((check) => check?.name === "doctor")
		: undefined;
	const failures = doctor?.details?.failures;
	const skillRootFailure = Array.isArray(failures)
		? failures.find((failure) => failure?.name === "host-skill-root")
		: undefined;
	const expectedCommand = `node ${shellQuote(cliPath)} skills install-bundle --host codex --cwd ${shellQuote(
		projectRoot,
	)} --write`;
	if (skillRootFailure?.recovery?.command !== expectedCommand) {
		fail("packaged CLI smoke failed: recovery command did not quote shell-sensitive paths");
	}

	runPackagedRecoveryCommand(cliPath, projectRoot, skillRootFailure.recovery.command);
	const repairedDoctor = parseJson(
		runCli(cliPath, ["doctor", "--host", "codex", "--cwd", projectRoot, "--json"]),
		"quoted CLI repaired doctor output",
	);
	if (repairedDoctor?.ok !== true) {
		fail("packaged CLI smoke failed: quoted CLI recovery command did not repair Codex host");
	}
}

function assertInitNextCommand(init, name) {
	const command = Array.isArray(init?.nextCommands)
		? init.nextCommands.find((candidate) => candidate?.name === name)
		: undefined;
	if (
		typeof command?.command !== "string" ||
		!command.command.includes(nameToCommandFragment(name))
	) {
		fail(`packaged CLI smoke failed: init next command is missing ${name}`);
	}
}

function nameToCommandFragment(name) {
	switch (name) {
		case "skills-status":
			return "skills status";
		case "route-do":
			return "route";
		default:
			return name;
	}
}

function assertPackagedRoute(cliPath, projectRoot, dbPath) {
	const route = parseJson(
		runCli(cliPath, [
			"route",
			"--host",
			"codex",
			"--cwd",
			projectRoot,
			"--skill",
			"do",
			"--ambiguity-score",
			"0.25",
			"--db",
			dbPath,
		]),
		"codex route output",
	);
	if (route?.blocked !== true || route?.reason !== "blocked:ambiguity") {
		fail("packaged CLI smoke failed: ambiguity gate did not block /do");
	}

	const sessionId = "packaged-route-cwd-session";
	const recorded = parseJson(
		runCli(cliPath, [
			"route",
			"--host",
			"codex",
			"--cwd",
			projectRoot,
			"--skill",
			"do",
			"--session",
			sessionId,
			"--result",
			"success",
		]),
		"codex route cwd-store output",
	);
	if (recorded?.sessionId !== sessionId || recorded?.skill !== "do") {
		fail("packaged CLI smoke failed: route --cwd did not record the expected decision");
	}
	assertFile(smokePath(projectRoot, ".harness", "store.db"));

	const trace = parseJson(
		runCli(cliPath, ["router-trace", "--cwd", projectRoot, "--session", sessionId]),
		"codex route cwd-store trace output",
	);
	if (
		!Array.isArray(trace) ||
		trace[0]?.sessionId !== sessionId ||
		trace[0]?.result !== "success"
	) {
		fail("packaged CLI smoke failed: router-trace --cwd did not read the project EventStore");
	}

	const futureTrace = parseJson(
		runCli(cliPath, [
			"router-trace",
			"--cwd",
			projectRoot,
			"--session",
			sessionId,
			"--since",
			"9999-01-01T00:00:00.000Z",
		]),
		"codex route future-since trace output",
	);
	if (!Array.isArray(futureTrace) || futureTrace.length !== 0) {
		fail("packaged CLI smoke failed: router-trace --since did not filter future decisions");
	}

	const decisions = parseJson(
		runCli(cliPath, [
			"export-decisions",
			"--cwd",
			projectRoot,
			"--skill",
			"do",
			"--since",
			"2000-01-01T00:00:00.000Z",
		]),
		"codex export-decisions output",
	);
	if (
		!Array.isArray(decisions) ||
		decisions[0]?.sessionId !== sessionId ||
		decisions[0]?.source?.type !== "router_decision"
	) {
		fail("packaged CLI smoke failed: export-decisions did not return router decision candidates");
	}

	const decisionsPath = join(projectRoot, "decisions.md");
	runCli(cliPath, [
		"export-decisions",
		"--cwd",
		projectRoot,
		"--skill",
		"do",
		"--markdown",
		"--write",
		decisionsPath,
	]);
	assertFile(decisionsPath);
	const decisionsMarkdown = readFileSync(decisionsPath, "utf8");
	assertIncludes(decisionsMarkdown, "# Paveda Decision Candidates");
	assertIncludes(decisionsMarkdown, `session: ${sessionId}`);
	const externalDecisionsPath = join(projectRoot, "external-decisions.md");
	const linkedDecisionsPath = join(projectRoot, "linked-decisions.md");
	writeFileSync(externalDecisionsPath, "external decisions\n");
	symlinkSync(externalDecisionsPath, linkedDecisionsPath);
	const symlinkDecisionsWrite = runCliResult(cliPath, [
		"export-decisions",
		"--cwd",
		projectRoot,
		"--write",
		linkedDecisionsPath,
	]);
	if (
		symlinkDecisionsWrite.status !== 1 ||
		!symlinkDecisionsWrite.stderr.includes("Output path must not use symlinks")
	) {
		fail(
			`packaged CLI smoke failed: export-decisions --write accepted a symlink path\n${symlinkDecisionsWrite.stderr}`,
		);
	}
	if (readFileSync(externalDecisionsPath, "utf8") !== "external decisions\n") {
		fail("packaged CLI smoke failed: export-decisions --write modified a symlink target");
	}
}

function assertPackagedSkillsCli(cliPath, projectRoot, hostCase) {
	const bundle = parseJson(
		runCli(cliPath, [
			"skills",
			"install-bundle",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--skills",
			"do,verify",
			"--write",
			"--force",
		]),
		`${hostCase.host} skills install-bundle output`,
	);
	if (bundle?.host !== hostCase.host || bundle?.written !== true) {
		fail(`packaged CLI smoke failed: ${hostCase.host} skills install-bundle did not write`);
	}
	assertSkillNames(bundle?.skills, ["do", "verify"]);
	assertFile(smokePath(projectRoot, hostCase.skillRoot, "do", "SKILL.md"));
	assertFile(smokePath(projectRoot, hostCase.skillRoot, "verify", "SKILL.md"));
	if (hostCase.hermesConfigFile) {
		assertFile(smokePath(projectRoot, hostCase.hermesConfigFile));
	}

	if (hostCase.host === "claude-code") {
		parseJson(
			runCli(cliPath, [
				"install",
				"claude-code",
				"--path",
				smokePath(projectRoot, ".claude/settings.json"),
				"--cli-path",
				cliPath,
				"--write",
			]),
			"claude-code install output",
		);
	}

	const status = parseJson(
		runCli(cliPath, ["skills", "status", "--host", hostCase.host, "--cwd", projectRoot]),
		`${hostCase.host} skills status output`,
	);
	assertProjectSkillStatus(status, "do", true);
	assertProjectSkillStatus(status, "verify", false);

	if (canonicalOptionalSkillNames.length > 0) {
		const selectedOptionalSkills = canonicalOptionalSkillNames.slice(0, 2);
		const optionalBundle = parseJson(
			runCli(cliPath, [
				"skills",
				"install-bundle",
				"--host",
				hostCase.host,
				"--cwd",
				projectRoot,
				"--skills",
				selectedOptionalSkills.join(","),
				"--write",
				"--force",
			]),
			`${hostCase.host} optional skills install-bundle output`,
		);
		assertSkillNames(optionalBundle?.skills, selectedOptionalSkills);
		for (const skillName of selectedOptionalSkills) {
			assertFile(smokePath(projectRoot, hostCase.skillRoot, skillName, "SKILL.md"));
		}

		const includeOptionalProjectRoot = `${projectRoot}-include-optional`;
		const includeOptionalBundle = parseJson(
			runCli(cliPath, [
				"skills",
				"install-bundle",
				"--host",
				hostCase.host,
				"--cwd",
				includeOptionalProjectRoot,
				"--include-optional",
				"--write",
				"--force",
			]),
			`${hostCase.host} include optional skills install-bundle output`,
		);
		assertSkillNames(includeOptionalBundle?.skills, canonicalSkillNames);
		for (const skillName of canonicalOptionalSkillNames) {
			assertFile(smokePath(includeOptionalProjectRoot, hostCase.skillRoot, skillName, "SKILL.md"));
		}
	}
}

function assertPackagedCustomTargetRoot(cliPath, projectRoot, hostCase, targetRoot) {
	if (!hostCase) {
		fail("packaged CLI smoke failed: missing host case for custom target-root smoke");
	}

	const bundle = parseJson(
		runCli(cliPath, [
			"skills",
			"install-bundle",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--target-root",
			targetRoot,
			"--skills",
			"do",
			"--write",
		]),
		`${hostCase.host} custom target-root install-bundle output`,
	);
	if (bundle?.targetRoot !== smokePath(projectRoot, targetRoot)) {
		fail(`packaged CLI smoke failed: ${hostCase.host} custom targetRoot was not cwd-relative`);
	}

	const skillPath = smokePath(projectRoot, targetRoot, "do", "SKILL.md");
	assertFile(skillPath);
	assertMissingFile(smokePath(projectRoot, hostCase.skillRoot, "do", "SKILL.md"));
	const doSkillText = readFileSync(skillPath, "utf8");
	assertIncludes(doSkillText, `${targetRoot}/do/scripts/detect-stagnation.sh`);
	assertIncludes(doSkillText, `${hostCase.contextRoot}/backend-patterns.md`);

	const instruction = readFileSync(smokePath(projectRoot, hostCase.instructionFile), "utf8");
	assertIncludes(instruction, `- Workflow skills: \`${targetRoot}\``);

	const codexMetadataPath = smokePath(projectRoot, targetRoot, "do", "agents", "openai.yaml");
	if (hostCase.createsCodexMetadata) {
		assertFile(codexMetadataPath);
	} else {
		assertMissingFile(codexMetadataPath);
	}

	if (hostCase.hermesConfigFile) {
		const config = readFileSync(smokePath(projectRoot, hostCase.hermesConfigFile), "utf8");
		assertIncludes(config, `    - ${targetRoot}`);
		assertExcludes(config, "    - .hermes/skills");
	}

	const status = parseJson(
		runCli(cliPath, [
			"skills",
			"status",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--target-root",
			targetRoot,
		]),
		`${hostCase.host} custom target-root skills status output`,
	);
	assertProjectSkillStatus(status, "do", true);

	const doctor = parseJson(
		runCli(cliPath, [
			"doctor",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--target-root",
			targetRoot,
			"--json",
		]),
		`${hostCase.host} custom target-root doctor output`,
	);
	if (!doctor?.ok) {
		fail(`packaged CLI smoke failed: ${hostCase.host} custom target-root doctor is not ok`);
	}

	const route = parseJson(
		runCli(cliPath, [
			"route",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--target-root",
			targetRoot,
			"--skill",
			"do",
			"--ambiguity-score",
			"0.25",
		]),
		`${hostCase.host} custom target-root route output`,
	);
	if (route?.reason !== "blocked:ambiguity") {
		fail(`packaged CLI smoke failed: ${hostCase.host} custom target-root route did not block`);
	}

	const adoption = parseJson(
		runCli(cliPath, [
			"adoption-report",
			"--host",
			hostCase.host,
			"--cwd",
			projectRoot,
			"--target-root",
			targetRoot,
			"--json",
		]),
		`${hostCase.host} custom target-root adoption report output`,
	);
	if (adoption?.ok !== true) {
		fail(`packaged CLI smoke failed: ${hostCase.host} custom target-root adoption report failed`);
	}
}

function assertPackagedCustomTargetSkillScript(cliPath, projectRoot, hostCase, targetRoot) {
	if (!hostCase) {
		fail("packaged CLI smoke failed: missing host case for custom target-root script smoke");
	}

	runCli(cliPath, [
		"skills",
		"install-bundle",
		"--host",
		hostCase.host,
		"--cwd",
		projectRoot,
		"--target-root",
		targetRoot,
		"--skills",
		"do,specify",
		"--write",
	]);
	const scriptPath = smokePath(
		projectRoot,
		targetRoot,
		"specify",
		"scripts",
		"check-ambiguity-frontmatter.sh",
	);
	assertFile(scriptPath);
	const result = spawnSync("bash", [scriptPath], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1" },
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		fail(`packaged CLI smoke failed to run custom target script: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(
			`packaged CLI smoke failed: custom target skill script did not resolve sibling skills\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}

	const doScriptRoot = smokePath(projectRoot, targetRoot, "do", "scripts");
	assertBashJsonEquals(
		join(doScriptRoot, "detect-stagnation.sh"),
		[join(doScriptRoot, "test-fixtures", "iterator", "spinning.jsonl")],
		join(doScriptRoot, "test-fixtures", "iterator", "spinning.expected.json"),
		"custom target detect-stagnation",
	);
	assertBashJsonEquals(
		join(doScriptRoot, "detect-stagnation-cross-sprint.sh"),
		[join(doScriptRoot, "test-fixtures", "iterator", "cross-sprint-meta-spin.jsonl")],
		join(doScriptRoot, "test-fixtures", "iterator", "cross-sprint-meta-spin.expected.json"),
		"custom target detect-stagnation-cross-sprint",
	);
}

function assertBashJsonEquals(scriptPath, args, expectedPath, label) {
	assertFile(scriptPath);
	assertFile(expectedPath);
	const result = spawnSync("bash", [scriptPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1" },
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		fail(`packaged CLI smoke failed to run ${label}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(
			`packaged CLI smoke failed: ${label} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}

	const actual = parseJson(result.stdout, label);
	const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		fail(
			`packaged CLI smoke failed: ${label} output mismatch\nexpected:\n${JSON.stringify(
				expected,
			)}\nactual:\n${JSON.stringify(actual)}`,
		);
	}
}

function assertPackagedVersion(packageRoot) {
	const version = execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				`import { VERSION } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "index.js")).href)};`,
				"console.log(VERSION);",
			].join("\n"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	).trim();

	if (version !== packageJson.version) {
		fail(
			`packaged CLI smoke failed: exported VERSION is ${version}, expected ${packageJson.version}`,
		);
	}
}

function assertPackagedHookLibraryApi(packageRoot) {
	const output = execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				`import { blastCheck, destructiveGuard, hooks, sessionContext, testProcessCleanup, toolingEnforce } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "index.js")).href)};`,
				"const result = {",
				"  sessionAlias: hooks.collectSessionContext === sessionContext.collectSessionContext,",
				"  cleanupMatched: testProcessCleanup.evaluateTestProcessCleanup(",
				"    { toolName: 'Bash', toolInput: { command: 'pnpm test' } },",
				"    { listPids: () => [111, 222], killPid: () => true, currentPid: 111, parentPid: 333 },",
				"  ),",
				"  destructive: destructiveGuard.evaluateDestructiveGuard({ toolName: 'Write', toolInput: { file_path: '.env.local' } }),",
				"  blast: blastCheck.evaluateBlastCheck({ toolName: 'Write', toolInput: { file_path: 'package.json', content: '{\"dependencies\":{}}' } }),",
				"  tooling: toolingEnforce.evaluateToolingEnforce({ toolName: 'Bash', toolInput: { command: 'grep TODO src' } }),",
				"};",
				"console.log(JSON.stringify(result));",
			].join("\n"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const result = parseJson(output, "packaged hook library API output");
	if (result?.sessionAlias !== true) {
		fail("packaged CLI smoke failed: sessionContext export does not match legacy hooks alias");
	}
	if (
		result?.cleanupMatched?.matched !== true ||
		result.cleanupMatched.killedPids?.length !== 1 ||
		result.cleanupMatched.killedPids[0] !== 222
	) {
		fail("packaged CLI smoke failed: test process cleanup hook library API is unavailable");
	}
	if (result?.destructive?.decision !== "deny") {
		fail("packaged CLI smoke failed: destructive guard hook library API is unavailable");
	}
	if (!Array.isArray(result?.blast?.warnings) || result.blast.warnings.length === 0) {
		fail("packaged CLI smoke failed: blast check hook library API is unavailable");
	}
	if (result?.tooling?.decision !== "deny" || result.tooling.alternative !== "Grep") {
		fail("packaged CLI smoke failed: tooling enforcement hook library API is unavailable");
	}
}

function assertPackagedEventStoreLibraryApi(packageRoot, dbPath) {
	const output = execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				`import { store } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "index.js")).href)};`,
				`const eventStore = new store.EventStore(${JSON.stringify(dbPath)});`,
				"const promoted = eventStore.appendInstinct({",
				"  scope: 'project',",
				"  pattern: 'Package smoke instinct',",
				"  evidence: 'packaged library api',",
				"  examples: [{ command: 'pnpm release:check' }],",
				"  confidence: 0.81,",
				"  status: 'active',",
				"});",
				"const expired = eventStore.appendInstinct({",
				"  scope: 'project',",
				"  pattern: 'Expired package smoke instinct',",
				"  confidence: 0.4,",
				"  ttlExpiresAt: 100,",
				"  status: 'pending',",
				"});",
				"eventStore.updateInstinctStatus(promoted.id, 'promoted');",
				"const visible = eventStore.listInstincts({ now: 200 });",
				"const expiredRows = eventStore.listInstincts({ status: 'expired', now: 200 });",
				"eventStore.close();",
				"console.log(JSON.stringify({ visible, expiredRows, promotedId: promoted.id, expiredId: expired.id }));",
			].join("\n"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const result = parseJson(output, "packaged EventStore library API output");
	if (
		!Array.isArray(result?.visible) ||
		!result.visible.some(
			(instinct) =>
				instinct?.id === result.promotedId &&
				instinct?.status === "promoted" &&
				instinct?.examples?.[0]?.command === "pnpm release:check",
		)
	) {
		fail("packaged CLI smoke failed: EventStore instinct library API did not list promoted record");
	}
	if (
		!Array.isArray(result?.expiredRows) ||
		!result.expiredRows.some(
			(instinct) => instinct?.id === result.expiredId && instinct?.status === "expired",
		)
	) {
		fail("packaged CLI smoke failed: EventStore instinct library API did not expire TTL record");
	}
}

function assertPackagedProjectExtensionGuards(packageRoot) {
	const output = execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				"import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';",
				"import { tmpdir } from 'node:os';",
				"import { join } from 'node:path';",
				`import { projectChecks, projectHooks } from ${JSON.stringify(pathToFileURL(join(packageRoot, "dist", "index.js")).href)};`,
				"const cwd = mkdtempSync(join(tmpdir(), 'paveda-packaged-extensions-'));",
				"try {",
				"  const hooksDir = join(cwd, '.harness', 'hooks');",
				"  const checksDir = join(cwd, '.harness', 'checks');",
				"  const outsideDir = join(cwd, 'outside');",
				"  const eventDir = join(hooksDir, 'PostToolUse');",
				"  const escapedToolDir = join(cwd, '.harness', 'escaped-tool-dir');",
				"  mkdirSync(hooksDir, { recursive: true });",
				"  mkdirSync(checksDir, { recursive: true });",
				"  mkdirSync(outsideDir, { recursive: true });",
				"  mkdirSync(eventDir, { recursive: true });",
				"  mkdirSync(escapedToolDir, { recursive: true });",
				"  const escapedEventHook = join(cwd, '.harness', 'escaped-event.sh');",
				"  const escapedToolHook = join(escapedToolDir, 'escaped-tool.sh');",
				"  const outsideHook = join(outsideDir, 'outside-hook.sh');",
				"  const outsideCheck = join(outsideDir, 'outside-check.sh');",
				"  writeFileSync(escapedEventHook, '#!/bin/sh\\necho escaped\\n');",
				"  writeFileSync(escapedToolHook, '#!/bin/sh\\necho escaped tool\\n');",
				"  writeFileSync(outsideHook, '#!/bin/sh\\necho outside hook\\n');",
				"  writeFileSync(outsideCheck, '#!/bin/sh\\necho outside check\\n');",
				"  chmodSync(escapedEventHook, 0o755);",
				"  chmodSync(escapedToolHook, 0o755);",
				"  chmodSync(outsideHook, 0o755);",
				"  chmodSync(outsideCheck, 0o755);",
				"  symlinkSync(outsideHook, join(hooksDir, 'linked-hook.sh'));",
				"  symlinkSync(outsideDir, join(hooksDir, 'LinkedEvent'));",
				"  symlinkSync(outsideCheck, join(checksDir, 'linked-check.sh'));",
				"  const eventTraversal = projectHooks.runProjectHooks({ cwd, raw: { hook_event_name: '..', session_id: 's' } });",
				"  const toolTraversal = projectHooks.runProjectHooks({ cwd, raw: { hook_event_name: 'PostToolUse', tool_name: '../../escaped-tool-dir', session_id: 's' } });",
				"  const hookSymlink = projectHooks.runProjectHooks({ cwd });",
				"  const hookDirSymlink = projectHooks.runProjectHooks({ cwd, raw: { hook_event_name: 'LinkedEvent', session_id: 's' } });",
				"  const checkSymlink = projectChecks.runProjectChecks({ cwd });",
				"  console.log(JSON.stringify({",
				"    eventTraversalCount: eventTraversal.executions.length,",
				"    toolTraversalCount: toolTraversal.executions.length,",
				"    hookSymlinkCount: hookSymlink.executions.length,",
				"    hookDirSymlinkCount: hookDirSymlink.executions.length,",
				"    checkSymlinkCount: checkSymlink.executions.length,",
				"  }));",
				"} finally {",
				"  rmSync(cwd, { recursive: true, force: true });",
				"}",
			].join("\n"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	const result = parseJson(output, "packaged project extension guard output");
	if (result?.eventTraversalCount !== 0 || result?.toolTraversalCount !== 0) {
		fail("packaged CLI smoke failed: project hooks allowed path traversal segments");
	}
	if (result?.hookSymlinkCount !== 0 || result?.hookDirSymlinkCount !== 0) {
		fail("packaged CLI smoke failed: project hooks executed symlinked files");
	}
	if (result?.checkSymlinkCount !== 0) {
		fail("packaged CLI smoke failed: project checks executed symlinked files");
	}
}

function assertPackagedBuiltinSkillInstall(cliPath, projectRoot) {
	const dryRun = parseJson(
		runCli(cliPath, ["skills", "install", "do", "--cwd", projectRoot]),
		"builtin skill install dry-run output",
	);
	const skillPath = smokePath(projectRoot, ".harness", "skills", "do", "SKILL.md");
	const referencePath = smokePath(
		projectRoot,
		".harness",
		"skills",
		"do",
		"references",
		"test-rules.md",
	);
	if (dryRun?.written !== false || dryRun?.targetPath !== skillPath) {
		fail("packaged CLI smoke failed: skills install dry-run returned the wrong target");
	}
	assertMissingFile(skillPath);

	const written = parseJson(
		runCli(cliPath, ["skills", "install", "do", "--cwd", projectRoot, "--write"]),
		"builtin skill install write output",
	);
	if (written?.written !== true || written?.targetPath !== skillPath) {
		fail("packaged CLI smoke failed: skills install did not write the expected target");
	}
	assertFile(skillPath);
	assertFile(referencePath);

	const externalReference = smokePath(projectRoot, "external-reference.md");
	writeFileSync(externalReference, "external reference\n");
	rmSync(referencePath, { force: true });
	symlinkSync(externalReference, referencePath);
	const nestedSymlink = runCliResult(cliPath, [
		"skills",
		"install",
		"do",
		"--cwd",
		projectRoot,
		"--write",
		"--force",
	]);
	if (
		nestedSymlink.status !== 1 ||
		!nestedSymlink.stderr.includes("Skill write path must not use symlinks")
	) {
		fail(
			`packaged CLI smoke failed: skills install accepted a nested symlink target\n${nestedSymlink.stderr}`,
		);
	}
	if (readFileSync(externalReference, "utf8") !== "external reference\n") {
		fail("packaged CLI smoke failed: skills install modified a nested symlink target");
	}
}

function assertPackagedEnableRouterCommand(cliPath, projectRoot) {
	const skillDir = smokePath(projectRoot, ".harness", "skills", "do");
	const skillPath = join(skillDir, "SKILL.md");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		skillPath,
		["---", "name: do", "description: local do override", "---", "", "# Local do", ""].join("\n"),
	);

	const beforeStatus = parseJson(
		runCli(cliPath, ["skills", "status", "--cwd", projectRoot]),
		"enable-router before status output",
	);
	const beforeDo = findSkillStatusEntry(beforeStatus, "do");
	if (!beforeDo?.issues?.some((issue) => issue?.code === "router-enabled-skill-shadowed")) {
		fail("packaged CLI smoke failed: local /do override did not report router shadowing");
	}

	const dryRun = parseJson(
		runCli(cliPath, [
			"skills",
			"enable-router",
			"do",
			"--cwd",
			projectRoot,
			"--ambiguity-required",
			"0.35",
		]),
		"enable-router dry-run output",
	);
	if (
		dryRun?.written !== false ||
		dryRun?.changed !== true ||
		dryRun?.ambiguityRequired !== 0.35 ||
		!String(dryRun?.preview ?? "").includes("ambiguity-required: 0.35")
	) {
		fail("packaged CLI smoke failed: enable-router dry-run did not preview router metadata");
	}
	if (readFileSync(skillPath, "utf8").includes("router: enabled")) {
		fail("packaged CLI smoke failed: enable-router dry-run modified the local skill");
	}

	const written = parseJson(
		runCli(cliPath, [
			"skills",
			"enable-router",
			"do",
			"--cwd",
			projectRoot,
			"--ambiguity-required",
			"0.35",
			"--write",
		]),
		"enable-router write output",
	);
	if (
		written?.written !== true ||
		written?.changed !== true ||
		written?.ambiguityRequired !== 0.35
	) {
		fail("packaged CLI smoke failed: enable-router write did not report the updated threshold");
	}
	const afterText = readFileSync(skillPath, "utf8");
	assertIncludes(afterText, "router: enabled");
	assertIncludes(afterText, "ambiguity-required: 0.35");

	const preserveExisting = parseJson(
		runCli(cliPath, ["skills", "enable-router", "do", "--cwd", projectRoot, "--write"]),
		"enable-router preserve output",
	);
	if (
		preserveExisting?.written !== false ||
		preserveExisting?.changed !== false ||
		preserveExisting?.ambiguityRequired !== 0.35
	) {
		fail("packaged CLI smoke failed: enable-router did not preserve an existing threshold");
	}

	const afterStatus = parseJson(
		runCli(cliPath, ["skills", "status", "--cwd", projectRoot]),
		"enable-router after status output",
	);
	const afterDo = findSkillStatusEntry(afterStatus, "do");
	if (
		afterDo?.selected?.router !== "enabled" ||
		afterDo?.selected?.ambiguityRequired !== 0.35 ||
		(afterDo?.issues?.length ?? 0) !== 0
	) {
		fail("packaged CLI smoke failed: enable-router did not repair local /do status");
	}
}

function assertPackagedPortCommand(cliPath) {
	const worktreeName = "paveda";
	const expectedOffset = 25;
	const json = parseJson(
		runCli(cliPath, ["port", "--name", worktreeName, "--json"]),
		"port json output",
	);
	if (json?.worktreeName !== worktreeName || json?.offset !== expectedOffset) {
		fail("packaged CLI smoke failed: port --json returned the wrong worktree identity");
	}
	assertResolvedPort(json?.ports?.PORT, 3000, expectedOffset, "PORT");
	assertResolvedPort(json?.ports?.API_PORT, 3001, expectedOffset, "API_PORT");
	assertResolvedPort(json?.ports?.AUX_PORT, 3002, expectedOffset, "AUX_PORT");

	const shell = runCli(cliPath, ["port", "--name", worktreeName]).trim();
	if (
		shell !==
		[
			`export PORT=${json.ports.PORT}`,
			`export API_PORT=${json.ports.API_PORT}`,
			`export AUX_PORT=${json.ports.AUX_PORT}`,
		].join("\n")
	) {
		fail("packaged CLI smoke failed: port shell output did not match JSON output");
	}
}

function assertPackagedPolicyBundleCommand(cliPath, workDir) {
	mkdirSync(workDir, { recursive: true });

	const bundle = parseJson(
		runCli(cliPath, [
			"policy",
			"bundle",
			"--issuer",
			"package-smoke",
			"--generated-at",
			"2026-06-01T00:00:00.000Z",
		]),
		"policy bundle output",
	);
	if (
		bundle?.bundle?.schemaVersion !== 1 ||
		bundle?.bundle?.issuer !== "package-smoke" ||
		bundle?.bundle?.generatedAt !== "2026-06-01T00:00:00.000Z" ||
		!/^[a-f0-9]{64}$/.test(bundle?.canonicalSha256 ?? "")
	) {
		fail("packaged CLI smoke failed: policy bundle did not return the expected artifact");
	}
	if (!bundle.bundle.rules.some((rule) => rule?.id === "workflow.verification.handoff-gate")) {
		fail("packaged CLI smoke failed: policy bundle did not include workflow policy rules");
	}
	if (!bundle.bundle.hostCapabilities.some((capability) => capability?.host === "codex")) {
		fail("packaged CLI smoke failed: policy bundle did not include host capabilities");
	}

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const oldKey = generateKeyPairSync("ed25519");
	const privateKeyPath = join(workDir, "policy-private.pem");
	const publicKeyPath = join(workDir, "policy-public.pem");
	const keyringPath = join(workDir, "policy-keyring.json");
	const signedBundlePath = join(workDir, "policy-signed.json");
	const cachePath = join(workDir, "policy-cache.json");
	writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
	writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
	writeFileSync(
		keyringPath,
		`${JSON.stringify(
			{
				keys: [
					{
						keyId: "old-package-smoke-key",
						publicKeyPem: oldKey.publicKey.export({ format: "pem", type: "spki" }).toString(),
					},
					{
						keyId: "package-smoke-key",
						publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
					},
				],
			},
			null,
			2,
		)}\n`,
	);

	runCli(cliPath, [
		"policy",
		"bundle",
		"--issuer",
		"package-smoke",
		"--generated-at",
		"2026-06-01T00:00:00.000Z",
		"--private-key",
		privateKeyPath,
		"--key-id",
		"package-smoke-key",
		"--write",
		signedBundlePath,
	]);

	const signedBundle = parseJson(readFileSync(signedBundlePath, "utf8"), "signed policy bundle");
	if (
		signedBundle?.signature?.algorithm !== "ed25519" ||
		signedBundle?.signature?.keyId !== "package-smoke-key"
	) {
		fail("packaged CLI smoke failed: policy bundle did not include an Ed25519 signature");
	}

	const verified = parseJson(
		runCli(cliPath, [
			"policy",
			"verify",
			"--bundle",
			signedBundlePath,
			"--public-key",
			publicKeyPath,
		]),
		"policy verify output",
	);
	if (
		verified?.ok !== true ||
		verified?.keyId !== "package-smoke-key" ||
		verified?.expectedSha256 !== signedBundle.canonicalSha256
	) {
		fail("packaged CLI smoke failed: policy verify did not accept the signed bundle");
	}

	const pulled = parseJson(
		runCli(cliPath, [
			"policy",
			"pull",
			"--source",
			signedBundlePath,
			"--keyring",
			keyringPath,
			"--cache",
			cachePath,
			"--write",
		]),
		"policy pull output",
	);
	if (
		pulled?.verification?.ok !== true ||
		pulled?.summary?.keyId !== "package-smoke-key" ||
		pulled?.cache?.written !== true
	) {
		fail("packaged CLI smoke failed: policy pull did not verify and cache the signed bundle");
	}
	const cache = parseJson(readFileSync(cachePath, "utf8"), "policy cache output");
	if (
		cache?.verification?.ok !== true ||
		cache?.summary?.canonicalSha256 !== signedBundle.canonicalSha256 ||
		cache?.signedBundle?.canonicalSha256 !== signedBundle.canonicalSha256
	) {
		fail("packaged CLI smoke failed: policy pull cache did not contain the signed bundle");
	}

	const policyDoctor = parseJson(
		runCliResult(cliPath, [
			"doctor",
			"--host",
			"codex",
			"--cwd",
			workDir,
			"--enforcement",
			"--policy-cache",
			cachePath,
			"--json",
		]).stdout,
		"policy source doctor output",
	);
	const policySourceCheck = policyDoctor?.checks?.find((check) => check?.name === "policy-source");
	if (
		policySourceCheck?.status !== "pass" ||
		policySourceCheck?.details?.policySource?.keyId !== "package-smoke-key" ||
		policySourceCheck?.details?.runtimeDrift?.ok !== true
	) {
		fail("packaged CLI smoke failed: doctor did not expose the verified policy cache source");
	}

	const policyAdoption = parseJson(
		runCliResult(cliPath, [
			"adoption-report",
			"--host",
			"codex",
			"--cwd",
			workDir,
			"--policy-cache",
			cachePath,
			"--json",
		]).stdout,
		"policy source adoption-report output",
	);
	const adoptionPolicySourceCheck = policyAdoption?.checks?.find(
		(check) => check?.name === "policy-source",
	);
	if (
		adoptionPolicySourceCheck?.status !== "pass" ||
		adoptionPolicySourceCheck?.details?.policySource?.keyId !== "package-smoke-key" ||
		adoptionPolicySourceCheck?.details?.runtimeDrift?.ok !== true
	) {
		fail("packaged CLI smoke failed: adoption-report did not expose the policy cache source");
	}

	const policyHookDbPath = join(workDir, "policy-hook.db");
	runCliWithInput(
		cliPath,
		["hook", "claude-code", "--db", policyHookDbPath],
		JSON.stringify({
			hook_event_name: "PreToolUse",
			session_id: "packaged-policy-source-session",
			cwd: workDir,
			tool_name: "Bash",
			tool_input: { command: "rm -rf /" },
		}),
		{ env: { PAVEDA_POLICY_CACHE: cachePath } },
	);
	const policyEvents = parseJson(
		runCli(cliPath, [
			"events",
			"--session",
			"packaged-policy-source-session",
			"--db",
			policyHookDbPath,
		]),
		"policy source hook events",
	);
	const policyDecisionEvent = policyEvents.find((event) => event?.type === "policy.decision");
	if (
		policyDecisionEvent?.payload?.evidence?.policySource?.type !== "bundle-cache" ||
		policyDecisionEvent.payload.evidence.policySource.keyId !== "package-smoke-key" ||
		policyDecisionEvent.payload.evidence.policySource.canonicalSha256 !==
			signedBundle.canonicalSha256
	) {
		fail("packaged CLI smoke failed: hook runtime did not attach verified policy cache source");
	}
}

function assertResolvedPort(value, base, offset, name) {
	if (
		!Number.isInteger(value) ||
		(value !== base && (value < base + offset || value > base + offset + 9))
	) {
		fail(`packaged CLI smoke failed: port ${name} resolved to an unexpected value`);
	}
}

function assertPackagedProjectCheckCommand(cliPath, projectRoot) {
	const checksDir = smokePath(projectRoot, ".harness", "checks");
	mkdirSync(checksDir, { recursive: true });
	writeFileSync(join(checksDir, "smoke.sh"), "#!/bin/sh\nprintf 'SMOKE_CHECK_OK\\n'\n", {
		mode: 0o755,
	});

	const json = parseJson(
		runCli(cliPath, ["check", "--cwd", projectRoot, "--json"]),
		"project check json output",
	);
	if (
		json?.ok !== true ||
		json?.executions?.length !== 1 ||
		json.executions[0]?.name !== "smoke" ||
		json.executions[0]?.stdout !== "SMOKE_CHECK_OK\n"
	) {
		fail("packaged CLI smoke failed: check --json did not execute the project check");
	}

	const filtered = runCli(cliPath, ["check", "smoke", "--cwd", projectRoot]);
	if (filtered !== "SMOKE_CHECK_OK\n") {
		fail("packaged CLI smoke failed: named check did not print project check stdout");
	}

	const failingProject = `${projectRoot}-failing`;
	const failingChecksDir = smokePath(failingProject, ".harness", "checks");
	mkdirSync(failingChecksDir, { recursive: true });
	writeFileSync(
		join(failingChecksDir, "fail.sh"),
		"#!/bin/sh\nprintf 'SMOKE_CHECK_FAIL\\n' >&2\nexit 3\n",
		{ mode: 0o755 },
	);
	const failure = runCliResult(cliPath, ["check", "--cwd", failingProject, "--json"]);
	if (failure.status !== 1) {
		fail("packaged CLI smoke failed: failing project check did not set a failing exit code");
	}
	const failureJson = parseJson(failure.stdout, "failing project check json output");
	if (
		failureJson?.ok !== false ||
		failureJson?.executions?.[0]?.name !== "fail" ||
		failureJson.executions[0]?.status !== 3 ||
		failureJson.executions[0]?.stderr !== "SMOKE_CHECK_FAIL\n"
	) {
		fail("packaged CLI smoke failed: failing project check did not report execution details");
	}
}

async function assertPackagedConcurrentRouteCommands(cliPath, projectRoot) {
	runCli(cliPath, ["init", "--host", "codex", "--cwd", projectRoot, "--write"]);
	assertMissingFile(smokePath(projectRoot, ".harness", "store.db"));
	const results = await Promise.all([
		runCliAsync(cliPath, ["route", "--host", "codex", "--cwd", projectRoot, "--skill", "do"]),
		runCliAsync(cliPath, [
			"route",
			"--host",
			"codex",
			"--cwd",
			projectRoot,
			"--skill",
			"do",
			"--ambiguity-score",
			"0.25",
		]),
	]);

	for (const result of results) {
		if (result.status !== 0) {
			fail(
				`packaged CLI smoke failed: concurrent route command exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
		}
	}

	const normalRoute = parseJson(results[0].stdout, "concurrent route output");
	const ambiguousRoute = parseJson(results[1].stdout, "concurrent ambiguous route output");
	if (
		normalRoute?.enabled !== true ||
		normalRoute?.blocked !== false ||
		ambiguousRoute?.enabled !== true ||
		ambiguousRoute?.reason !== "blocked:ambiguity"
	) {
		fail("packaged CLI smoke failed: concurrent route commands returned unexpected decisions");
	}
	assertFile(smokePath(projectRoot, ".harness", "store.db"));
}

function runCli(cliPath, args) {
	return execFileSync("node", [cliPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1" },
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function runCliAsync(cliPath, args) {
	return new Promise((resolve) => {
		const child = spawn("node", [cliPath, ...args], {
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` });
		});
		child.on("close", (status) => {
			resolve({ status: status ?? 1, stdout, stderr });
		});
	});
}

function runCliWithEnv(cliPath, args, env) {
	return execFileSync("node", [cliPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function runCliWithInput(cliPath, args, input, options = {}) {
	return execFileSync("node", [cliPath, ...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1", ...(options.env ?? {}) },
		input,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["pipe", "pipe", "inherit"],
	});
}

function runCliResult(cliPath, args, options = {}) {
	const result = spawnSync("node", [cliPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1", ...(options.env ?? {}) },
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		fail(`packaged CLI smoke failed to run command: ${result.error.message}`);
	}
	return result;
}

function runCliInputResult(cliPath, args, input, options = {}) {
	const result = spawnSync("node", [cliPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, NODE_NO_WARNINGS: "1", ...(options.env ?? {}) },
		input,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.error) {
		fail(`packaged CLI smoke failed to run command: ${result.error.message}`);
	}
	return result;
}

function runPackagedRecoveryCommand(cliPath, projectRoot, command) {
	const binDir = join(projectRoot, ".paveda-smoke-bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, "paveda"), '#!/bin/sh\nexec node "$PAVEDA_PACKAGED_CLI" "$@"\n', {
		mode: 0o755,
	});

	const result = spawnSync(command, {
		cwd: projectRoot,
		encoding: "utf8",
		env: {
			...process.env,
			NODE_NO_WARNINGS: "1",
			PAVEDA_PACKAGED_CLI: cliPath,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		},
		maxBuffer: 32 * 1024 * 1024,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error) {
		fail(`packaged CLI smoke failed to run recovery command: ${result.error.message}`);
	}
	if (result.status !== 0) {
		fail(
			`packaged CLI smoke failed: recovery command exited ${result.status}\ncommand:\n${command}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function assertCliExitCode(cliPath, args, expectedStatus, label) {
	const result = runCliResult(cliPath, args);
	if (result.status !== expectedStatus) {
		fail(
			`packaged CLI smoke failed: ${label} exited ${result.status}, expected ${expectedStatus}\n${result.stderr}`,
		);
	}
}

function assertNoStoreOnCliFailure(
	cliPath,
	args,
	expectedStderr,
	projectRoot,
	label,
	options = {},
) {
	const result = runCliResult(cliPath, args, options);
	if (result.status !== 1 || !result.stderr.includes(expectedStderr)) {
		fail(`packaged CLI smoke failed: ${label} did not fail clearly\n${result.stderr}`);
	}
	assertMissingFile(smokePath(projectRoot, ".harness", "store.db"));
}

function assertNoStoreOnCliInputFailure(
	cliPath,
	args,
	input,
	expectedStderr,
	projectRoot,
	label,
	options = {},
) {
	const result = runCliInputResult(cliPath, args, input, options);
	if (result.status !== 1 || !result.stderr.includes(expectedStderr)) {
		fail(`packaged CLI smoke failed: ${label} did not fail clearly\n${result.stderr}`);
	}
	assertMissingFile(smokePath(projectRoot, ".harness", "store.db"));
}

function assertNoStoreOnSymlinkWriteFailure(cliPath, command, projectRoot) {
	mkdirSync(projectRoot, { recursive: true });
	const externalPath = join(projectRoot, "external-output.md");
	const linkedPath = join(projectRoot, "linked-output.md");
	writeFileSync(externalPath, "external\n");
	symlinkSync(externalPath, linkedPath);
	const result = runCliResult(cliPath, [command, "--cwd", projectRoot, "--write", linkedPath]);
	if (result.status !== 1 || !result.stderr.includes("Output path must not use symlinks")) {
		fail(
			`packaged CLI smoke failed: ${command} symlink write did not fail clearly\n${result.stderr}`,
		);
	}
	if (readFileSync(externalPath, "utf8") !== "external\n") {
		fail(`packaged CLI smoke failed: ${command} symlink write modified external output`);
	}
	assertMissingFile(smokePath(projectRoot, ".harness", "store.db"));
}

function seedFailedSession(cliPath, dbPath, sessionId) {
	execFileSync(
		"node",
		[
			"--input-type=module",
			"-e",
			[
				`import { store } from ${JSON.stringify(pathToFileURL(join(dirname(cliPath), "index.js")).href)};`,
				`const eventStore = new store.EventStore(${JSON.stringify(dbPath)});`,
				"eventStore.append({",
				`  sessionId: ${JSON.stringify(sessionId)},`,
				"  type: 'session.completed',",
				"  ts: Date.now(),",
				"  payload: { status: 'failed', costUsd: 1.25 },",
				"});",
				"eventStore.close();",
			].join("\n"),
		],
		{
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1" },
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
}

function parseJson(output, label) {
	try {
		return JSON.parse(output);
	} catch (error) {
		fail(
			`could not parse packaged CLI ${label}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

function assertEventTypes(events, expectedTypes) {
	if (!Array.isArray(events)) {
		fail("packaged CLI smoke failed: events output is not an array");
	}

	const actualTypes = events.map((event) => (typeof event === "string" ? event : event?.type));
	const missing = expectedTypes.filter((type, index) => actualTypes[index] !== type);
	if (missing.length > 0) {
		fail(
			`packaged CLI smoke failed: event types were ${actualTypes.join(", ")}, expected ${expectedTypes.join(", ")}`,
		);
	}
}

function assertFile(path) {
	if (!existsSync(path)) {
		fail(`packaged CLI smoke failed: missing file ${path}`);
	}
}

function assertMissingFile(path) {
	if (existsSync(path)) {
		fail(`packaged CLI smoke failed: unexpected file ${path}`);
	}
}

function assertIncludes(value, expected) {
	if (!value.includes(expected)) {
		fail(`packaged CLI smoke failed: output does not include ${expected}`);
	}
}

function assertExcludes(value, expected) {
	if (value.includes(expected)) {
		fail(`packaged CLI smoke failed: output includes ${expected}`);
	}
}

function smokePath(root, path, ...parts) {
	return join(root, ...path.split("/"), ...parts);
}

function shellQuote(value) {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value;
	}

	return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertSkillNames(skills, names) {
	if (!Array.isArray(skills)) {
		fail("packaged CLI smoke failed: skills output is not an array");
	}

	const actual = new Set(skills.map((skill) => skill?.name).filter(Boolean));
	const missing = names.filter((name) => !actual.has(name));
	if (missing.length > 0) {
		fail(`packaged CLI smoke failed: missing skills ${missing.join(", ")}`);
	}
}

function assertProjectSkillStatus(status, name, routerEnabled) {
	if (!Array.isArray(status)) {
		fail("packaged CLI smoke failed: skills status output is not an array");
	}

	const entry = findSkillStatusEntry(status, name);
	if (entry?.selected?.scope !== "project") {
		fail(`packaged CLI smoke failed: ${name} is not selected from project skills`);
	}
	if (entry?.routerEnabled !== routerEnabled) {
		fail(`packaged CLI smoke failed: ${name} routerEnabled is not ${routerEnabled}`);
	}
}

function findSkillStatusEntry(status, name) {
	return Array.isArray(status) ? status.find((candidate) => candidate?.name === name) : undefined;
}

function assertPackagedSkillIdentities(packageRoot, skills) {
	for (const skill of skills) {
		const skillPath = join(packageRoot, "assets", "harness", skill.path, "SKILL.md");
		assertFile(skillPath);
		const actualName = readSkillFrontmatterName(readFileSync(skillPath, "utf8"));
		if (actualName !== skill.name) {
			fail(
				`packaged CLI smoke failed: ${skill.path}/SKILL.md frontmatter name is ${actualName}, expected ${skill.name}`,
			);
		}
	}
}

function readSkillFrontmatterName(raw) {
	if (!raw.startsWith("---\n")) {
		return undefined;
	}

	const end = raw.indexOf("\n---", 4);
	if (end === -1) {
		return undefined;
	}

	const match = raw.slice(4, end).match(/^name:\s*(.+)$/m);
	return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

function assertCheckStatus(doctor, name, status) {
	const check = Array.isArray(doctor?.checks)
		? doctor.checks.find((candidate) => candidate?.name === name)
		: undefined;
	if (check?.status !== status) {
		fail(`packaged CLI smoke failed: ${name} is not ${status}`);
	}
}
