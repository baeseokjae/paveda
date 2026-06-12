import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/store/index.js";
import { createWorktree, listWorktrees } from "../src/worktree/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("worktree CLI helpers", () => {
	it("lists git worktrees from porcelain output", () => {
		const repo = initRepo();
		const result = listWorktrees({ cwd: repo });
		expect(result.worktrees).toHaveLength(1);
		expect(result.worktrees[0]).toMatchObject({ path: realpathSync(repo), branch: "main" });
	});

	it("previews worktree create commands and records a preview event", () => {
		const repo = initRepo();
		const result = createWorktree({ cwd: repo, name: "feature-x", base: "main" });
		expect(result).toMatchObject({
			name: "feature-x",
			base: "main",
			branch: "paveda/feature-x",
			written: false,
			eventType: "worktree.create.preview",
		});
		expect(result.commands[0]).toContain("git worktree add");
		expect(result.ports.PORT).toBeGreaterThanOrEqual(3000);
	});

	it("persists worktree events in the EventStore and replays them correctly", () => {
		const store = openTempStore();
		const repo = initRepo();

		// Act 1: preview (write: false) — no real git worktree created
		const previewResult = createWorktree({
			cwd: repo,
			name: "feature-preview",
			base: "main",
			dbPath: store.path,
		});
		expect(previewResult.eventType).toBe("worktree.create.preview");

		// Act 2: actual create (write: true) — creates a real git worktree
		const createResult = createWorktree({
			cwd: repo,
			name: "feature-actual",
			base: "main",
			dbPath: store.path,
			write: true,
		});
		expect(createResult.eventType).toBe("worktree.created");

		// Close the initial store so the SQLite db is fully flushed
		store.close();

		// Re-open the store from the same path to verify persistence
		const replayed = new EventStore(store.path);

		// Replay events for the preview session
		const previewEvents = replayed.replay("worktree:feature-preview");
		expect(previewEvents).toHaveLength(1);
		expect(previewEvents[0]).toMatchObject({
			sessionId: "worktree:feature-preview",
			type: "worktree.create.preview",
			payload: {
				name: "feature-preview",
				base: "main",
				branch: "paveda/feature-preview",
			},
		});

		// Replay events for the actual create session
		const createEvents = replayed.replay("worktree:feature-actual");
		expect(createEvents).toHaveLength(1);
		expect(createEvents[0]).toMatchObject({
			sessionId: "worktree:feature-actual",
			type: "worktree.created",
			payload: {
				name: "feature-actual",
				base: "main",
				branch: "paveda/feature-actual",
			},
		});
		// Also verify the path was set (it exists in the payload)
		expect(createEvents[0].payload).toHaveProperty("path");
		expect(createEvents[0].payload).toHaveProperty("ports");

		replayed.close();
	});
});

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "paveda-worktree-"));
	tempDirs.push(dir);
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# test\n");
	writeFileSync(join(dir, "package.json"), '{ "name": "test" }\n');
	execFileSync("git", ["add", "README.md", "package.json"], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
	return dir;
}

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-worktree-event-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
