import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { type WorktreePorts, resolveWorktreePorts } from "../hooks/worktree-port.js";
import { EventStore, type StoreScope, resolveStorePath } from "../store/index.js";

export type WorktreeFinishAction = "merge" | "pr" | "discard";

export interface WorktreeCreateInput {
	cwd?: string;
	name: string;
	base?: string;
	host?: string;
	write?: boolean;
	dbPath?: string;
	storeScope?: StoreScope;
}

export interface WorktreeCreateResult {
	name: string;
	base: string;
	path: string;
	branch: string;
	ports: WorktreePorts;
	commands: string[];
	written: boolean;
	eventType: "worktree.created" | "worktree.create.preview";
}

export interface WorktreeListInput {
	cwd?: string;
}

export interface WorktreeListEntry {
	path: string;
	head: string | null;
	branch: string | null;
	bare: boolean;
	detached: boolean;
}

export interface WorktreeListResult {
	worktrees: WorktreeListEntry[];
}

export interface WorktreeFinishInput {
	cwd?: string;
	name: string;
	action?: string;
	dryRun?: boolean;
	force?: boolean;
	dbPath?: string;
	storeScope?: StoreScope;
}

export interface WorktreeFinishResult {
	name: string;
	action: WorktreeFinishAction;
	path: string;
	commands: string[];
	dirty: boolean;
	written: boolean;
	eventType: "worktree.finished" | "worktree.finish.preview";
}

export function createWorktree(input: WorktreeCreateInput): WorktreeCreateResult {
	assertWorktreeName(input.name);
	const cwd = resolve(input.cwd ?? process.cwd());
	const base = input.base ?? "main";
	const repoRoot = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	const branch = `paveda/${input.name}`;
	const worktreePath = resolve(dirname(repoRoot), `${basename(repoRoot)}-${input.name}`);
	const commands = [
		`git worktree add -b ${branch} ${worktreePath} ${base}`,
		`pnpm install --dir ${worktreePath}`,
		...(input.host ? [`paveda init --host ${input.host} --cwd ${worktreePath} --write`] : []),
	];
	const portsResult = resolveWorktreePortsSync(worktreePath, input.name);
	const eventType = input.write ? "worktree.created" : "worktree.create.preview";

	if (input.write) {
		git(cwd, ["worktree", "add", "-b", branch, worktreePath, base]);
		run("pnpm", ["install", "--dir", worktreePath], cwd);
		if (input.host) {
			run("paveda", ["init", "--host", input.host, "--cwd", worktreePath, "--write"], cwd);
		}
	}

	withStore(input, cwd, (store) =>
		store.append({
			sessionId: `worktree:${input.name}`,
			type: eventType,
			payload: { name: input.name, base, path: worktreePath, branch, ports: portsResult.ports },
		}),
	);

	return {
		name: input.name,
		base,
		path: worktreePath,
		branch,
		ports: portsResult.ports,
		commands,
		written: Boolean(input.write),
		eventType,
	};
}

export function listWorktrees(input: WorktreeListInput = {}): WorktreeListResult {
	const cwd = resolve(input.cwd ?? process.cwd());
	const output = git(cwd, ["worktree", "list", "--porcelain"]);
	return { worktrees: parseWorktreeList(output) };
}

export function finishWorktree(input: WorktreeFinishInput): WorktreeFinishResult {
	assertWorktreeName(input.name);
	const cwd = resolve(input.cwd ?? process.cwd());
	const action = parseFinishAction(input.action);
	const worktree = listWorktrees({ cwd }).worktrees.find((item) =>
		basename(item.path).endsWith(`-${input.name}`),
	);
	if (!worktree) {
		throw new Error(`Worktree not found: ${input.name}`);
	}
	const dirty = git(worktree.path, ["status", "--porcelain"]).trim().length > 0;
	if (dirty && !input.force && action !== "discard") {
		throw new Error(`Worktree is dirty: ${worktree.path}. Use --force or commit changes first.`);
	}
	const commands = finishCommands(action, worktree.path, worktree.branch);
	const write = !input.dryRun;
	if (write) {
		if (action === "merge" && worktree.branch) {
			git(cwd, ["merge", worktree.branch]);
		}
		if (action === "pr" && worktree.branch) {
			git(worktree.path, ["push", "-u", "origin", worktree.branch]);
			run("gh", ["pr", "create", "--fill"], worktree.path);
		}
		git(cwd, [
			"worktree",
			"remove",
			...(input.force || action === "discard" ? ["--force"] : []),
			worktree.path,
		]);
	}
	const eventType = write ? "worktree.finished" : "worktree.finish.preview";
	withStore(input, cwd, (store) =>
		store.append({
			sessionId: `worktree:${input.name}`,
			type: eventType,
			payload: { name: input.name, action, path: worktree.path, dirty },
		}),
	);
	return {
		name: input.name,
		action,
		path: worktree.path,
		commands,
		dirty,
		written: write,
		eventType,
	};
}

function finishCommands(
	action: WorktreeFinishAction,
	path: string,
	branch: string | null,
): string[] {
	if (action === "merge") {
		return branch
			? [`git merge ${branch}`, `git worktree remove ${path}`]
			: [`git worktree remove ${path}`];
	}
	if (action === "pr") {
		return branch
			? [
					`git -C ${path} push -u origin ${branch}`,
					"gh pr create --fill",
					`git worktree remove ${path}`,
				]
			: [`git worktree remove ${path}`];
	}
	return [`git worktree remove --force ${path}`];
}

function parseWorktreeList(output: string): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = [];
	for (const block of output.trim().split(/\n\n+/).filter(Boolean)) {
		const entry: WorktreeListEntry = {
			path: "",
			head: null,
			branch: null,
			bare: false,
			detached: false,
		};
		for (const line of block.split("\n")) {
			const [key, ...rest] = line.split(" ");
			const value = rest.join(" ");
			if (key === "worktree") entry.path = value;
			if (key === "HEAD") entry.head = value;
			if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
			if (key === "bare") entry.bare = true;
			if (key === "detached") entry.detached = true;
		}
		if (entry.path) entries.push(entry);
	}
	return entries;
}

function parseFinishAction(value: string | undefined): WorktreeFinishAction {
	if (value === undefined || value === "merge") return "merge";
	if (value === "pr" || value === "discard") return value;
	throw new Error(`Unsupported worktree finish action: ${value}`);
}

function assertWorktreeName(name: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
		throw new Error(`Invalid worktree name: ${name}`);
	}
}

function git(cwd: string, args: string[]): string {
	return run("git", args, cwd);
}

function run(command: string, args: string[], cwd: string): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
		);
	}
	return result.stdout;
}

function resolveWorktreePortsSync(cwd: string, worktreeName: string): { ports: WorktreePorts } {
	let done = false;
	let ports: WorktreePorts | undefined;
	void resolveWorktreePorts({ cwd, worktreeName, isPortAvailable: () => true }).then((result) => {
		ports = result.ports;
		done = true;
	});
	if (!done || !ports) {
		const offset =
			Array.from(worktreeName).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
		return { ports: { PORT: 3000 + offset, API_PORT: 3001 + offset, AUX_PORT: 3002 + offset } };
	}
	return { ports };
}

function withStore(
	input: { dbPath?: string; storeScope?: StoreScope },
	cwd: string,
	callback: (store: EventStore) => void,
): void {
	const store = new EventStore(
		input.dbPath ?? resolveStorePath(input.storeScope ?? "project", cwd),
	);
	try {
		callback(store);
	} finally {
		store.close();
	}
}
