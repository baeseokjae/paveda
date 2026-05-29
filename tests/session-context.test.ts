import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { collectSessionContext } from "../src/hooks/session-context.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session context hook", () => {
	it("collects git session context with working tree counts", () => {
		const cwd = makeGitRepo();
		writeFileSync(join(cwd, "tracked.txt"), "changed");
		writeFileSync(join(cwd, "new.txt"), "new");

		const context = collectSessionContext({ cwd, config: config() });

		expect(context).toMatchObject({
			cwd,
			branch: "main",
			workingTree: {
				staged: 0,
				modified: 1,
				untracked: 1,
			},
			truncated: false,
		});
		expect(context?.recentCommits).toHaveLength(1);
		expect(context?.additionalContext).toContain("Branch: main");
		expect(context?.additionalContext).toContain("Working tree: 0 staged, 1 modified, 1 untracked");
	});

	it("returns null outside git repos or when disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-context-empty-"));
		tempDirs.push(dir);

		expect(collectSessionContext({ cwd: dir, config: config() })).toBeNull();
		expect(
			collectSessionContext({
				cwd: makeGitRepo(),
				config: config({ sessionStartContext: false }),
			}),
		).toBeNull();
	});

	it("truncates additional context at configured length", () => {
		const context = collectSessionContext({
			cwd: makeGitRepo(),
			config: config({ sessionStartMaxChars: 40 }),
		});

		expect(context?.truncated).toBe(true);
		expect(context?.additionalContext.length).toBeLessThanOrEqual(40);
		expect(context?.additionalContext).toContain("[truncated]");
	});
});

function makeGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "paveda-context-"));
	tempDirs.push(dir);

	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	writeFileSync(join(dir, "tracked.txt"), "initial");
	execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

	return dir;
}

function config(overrides: Partial<PavedaConfig> = {}): PavedaConfig {
	return {
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: true,
		sessionStartMaxChars: 8000,
		costGuardMaxMinutes: 120,
		costGuardAgentWarningThreshold: 5,
		costGuardAgentCompactInterval: 3,
		...overrides,
	};
}
