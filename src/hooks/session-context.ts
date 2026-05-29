import { execFileSync } from "node:child_process";
import type { PavedaConfig } from "../core/index.js";
import { loadConfig } from "../core/index.js";

export interface SessionContext {
	cwd: string;
	branch: string;
	recentCommits: string[];
	workingTree: {
		staged: number;
		modified: number;
		untracked: number;
	};
	additionalContext: string;
	truncated: boolean;
}

export interface CollectSessionContextOptions {
	cwd?: string;
	config?: PavedaConfig;
}

export function collectSessionContext(
	options: CollectSessionContextOptions = {},
): SessionContext | null {
	const cwd = options.cwd ?? process.cwd();
	const config = options.config ?? loadConfig();

	if (!config.sessionStartContext || !isGitWorkTree(cwd)) {
		return null;
	}

	const branch = git(["branch", "--show-current"], cwd).trim() || "detached";
	const recentCommits = git(["log", "--oneline", "-3"], cwd)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const workingTree = {
		staged: countLines(git(["diff", "--cached", "--name-only"], cwd)),
		modified: countLines(git(["diff", "--name-only"], cwd)),
		untracked: countLines(git(["ls-files", "--others", "--exclude-standard"], cwd)),
	};

	const fullContext = [
		`Project: ${cwd}`,
		`Branch: ${branch}`,
		"Recent commits:",
		recentCommits.length > 0 ? recentCommits.join("\n") : "no commits",
		`Working tree: ${workingTree.staged} staged, ${workingTree.modified} modified, ${workingTree.untracked} untracked`,
	].join("\n");
	const additionalContext = truncateContext(fullContext, config.sessionStartMaxChars);

	return {
		cwd,
		branch,
		recentCommits,
		workingTree,
		additionalContext,
		truncated: additionalContext.length < fullContext.length,
	};
}

function isGitWorkTree(cwd: string): boolean {
	return git(["rev-parse", "--is-inside-work-tree"], cwd).trim() === "true";
}

function git(args: string[], cwd: string): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
}

function countLines(value: string): number {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}

function truncateContext(value: string, maxChars: number): string {
	if (value.length <= maxChars) {
		return value;
	}

	const suffix = "\n[truncated]";
	return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
