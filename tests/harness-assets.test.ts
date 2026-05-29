import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillDocument } from "../src/skill-loader/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnessRoot = join(repoRoot, "assets", "harness");

describe("harness assets", () => {
	it("keeps manifest instruction and context entries in sync with packaged files", () => {
		const contextRoot = join(harnessRoot, "context-modules");
		const manifest = JSON.parse(readFileSync(join(harnessRoot, "manifest.json"), "utf8")) as {
			instructions?: { path?: string };
			contextModules?: Array<{ name?: string; path?: string }>;
		};
		const packagedContextModules = readdirSync(contextRoot, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => `context-modules/${entry.name}`)
			.sort();
		const manifestContextModules = (manifest.contextModules ?? [])
			.map((module) => module.path)
			.filter((path): path is string => Boolean(path))
			.sort();

		expect(manifest.instructions?.path).toBe("AGENTS.md");
		expect(existsSync(join(harnessRoot, manifest.instructions.path))).toBe(true);
		expect(manifestContextModules).toEqual(packagedContextModules);
		for (const module of manifest.contextModules ?? []) {
			expect(module.path).toBe(module.name ? `context-modules/${module.name}.md` : undefined);
		}
	});

	it("keeps manifest skill entries in sync with packaged skill directories", () => {
		const skillsRoot = join(harnessRoot, "skills");
		const manifest = JSON.parse(readFileSync(join(harnessRoot, "manifest.json"), "utf8")) as {
			skills?: Array<{ name?: string; path?: string }>;
		};
		const packagedSkills = readdirSync(skillsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
		const manifestSkills = (manifest.skills ?? [])
			.map((skill) => skill.name)
			.filter((name): name is string => Boolean(name))
			.sort();

		expect(manifestSkills).toEqual(packagedSkills);
		for (const skill of manifest.skills ?? []) {
			expect(skill.path).toBe(skill.name ? `skills/${skill.name}` : undefined);
			if (skill.name && skill.path) {
				const raw = readFileSync(join(harnessRoot, skill.path, "SKILL.md"), "utf8");
				expect(parseSkillDocument(raw).frontmatter.name).toBe(skill.name);
			}
		}
	});

	it("does not reference missing packaged skills", () => {
		const skillsRoot = join(harnessRoot, "skills");
		const packagedSkills = new Set(
			readdirSync(skillsRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name),
		);
		const missingReferences = scanTextFiles(harnessRoot).flatMap((path) => {
			const content = readFileSync(path, "utf8");
			return [...content.matchAll(/\.harness\/skills\/([a-z0-9_-]+)\//g)]
				.map((match) => match[1])
				.filter((name) => name && !packagedSkills.has(name))
				.map((name) => `${relativeAssetPath(path)} -> ${name}`);
		});

		expect(missingReferences).toEqual([]);
	});

	it("does not reference missing packaged context modules", () => {
		const contextRoot = join(harnessRoot, "context-modules");
		const missingReferences = scanTextFiles(harnessRoot).flatMap((path) => {
			const content = readFileSync(path, "utf8");
			return [...content.matchAll(/\.harness\/context-modules\/([a-z0-9_-]+\.md)/g)]
				.map((match) => match[1])
				.filter((name) => name && !existsSync(join(contextRoot, name)))
				.map((name) => `${relativeAssetPath(path)} -> ${name}`);
		});

		expect(missingReferences).toEqual([]);
	});

	it("does not reference unpackaged bootstrap contracts", () => {
		const forbiddenPatterns = [
			/scripts\/init-do-flow\.sh/,
			/\.agentic-flow/,
			/docs\/agents\//,
			/scripts\/resolve-contract\.sh/,
			/contract\.json/,
			/verify_dev/,
		];
		const violations = scanTextFiles(harnessRoot).flatMap((path) => {
			const content = readFileSync(path, "utf8");
			return forbiddenPatterns
				.filter((pattern) => pattern.test(content))
				.map((pattern) => `${relativeAssetPath(path)} -> ${pattern.source}`);
		});

		expect(violations).toEqual([]);
	});

	it("does not bake application-specific paths or stack assumptions into harness assets", () => {
		const forbiddenPatterns = [
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
			/\bopus\b/i,
			/\bsonnet\b/i,
			/\bhaiku\b/i,
			/docs-writer/,
			/skills\.sh/,
			/pnpm lint/,
			/pnpm test/,
			/pnpm build/,
		];
		const violations = scanTextFiles(harnessRoot).flatMap((path) => {
			const content = readFileSync(path, "utf8");
			return forbiddenPatterns
				.filter((pattern) => pattern.test(content))
				.map((pattern) => `${relativeAssetPath(path)} -> ${pattern.source}`);
		});

		expect(violations).toEqual([]);
	});
});

function scanTextFiles(root: string): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			paths.push(...scanTextFiles(path));
			continue;
		}
		if (entry.isFile() && isTextFile(path)) {
			paths.push(path);
		}
	}
	return paths;
}

function isTextFile(path: string): boolean {
	return (
		[".json", ".md", ".sh", ".txt", ".yaml", ".yml"].includes(extname(path)) &&
		statSync(path).size < 1024 * 1024
	);
}

function relativeAssetPath(path: string): string {
	return path.slice(`${harnessRoot}/`.length);
}
