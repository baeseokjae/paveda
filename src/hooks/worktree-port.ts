import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { basename } from "node:path";

export const WORKTREE_PORT_SPECS = [
	{ name: "PORT", base: 3000 },
	{ name: "API_PORT", base: 3001 },
	{ name: "AUX_PORT", base: 3002 },
] as const;

export type WorktreePortName = (typeof WORKTREE_PORT_SPECS)[number]["name"];

export type WorktreePorts = Record<WorktreePortName, number>;

export interface ResolvedWorktreePorts {
	worktreeName: string;
	offset: number;
	ports: WorktreePorts;
}

export interface ResolveWorktreePortsOptions {
	cwd?: string;
	worktreeName?: string;
	isPortAvailable?: (port: number) => boolean | Promise<boolean>;
}

export function asciiSum(value: string): number {
	let sum = 0;
	for (const char of value) {
		sum += char.charCodeAt(0);
	}
	return sum;
}

export function worktreeOffset(worktreeName: string): number {
	return asciiSum(worktreeName) % 100;
}

export async function resolveWorktreePorts(
	options: ResolveWorktreePortsOptions = {},
): Promise<ResolvedWorktreePorts> {
	const worktreeName = options.worktreeName ?? resolveWorktreeName(options.cwd ?? process.cwd());
	const offset = worktreeOffset(worktreeName);
	const portAvailable = options.isPortAvailable ?? isTcpPortAvailable;
	const entries = await Promise.all(
		WORKTREE_PORT_SPECS.map(async ({ name, base }) => {
			const port = await resolvePort(base, offset, portAvailable);
			return [name, port] as const;
		}),
	);

	return {
		worktreeName,
		offset,
		ports: Object.fromEntries(entries) as WorktreePorts,
	};
}

export function formatWorktreePortsAsShell(result: ResolvedWorktreePorts): string {
	return WORKTREE_PORT_SPECS.map(({ name }) => `export ${name}=${result.ports[name]}`).join("\n");
}

export async function isTcpPortAvailable(port: number): Promise<boolean> {
	const lsofResult = isTcpPortAvailableByLsof(port);
	if (lsofResult !== undefined) {
		return lsofResult;
	}

	return new Promise((resolve) => {
		const server = createServer();
		let settled = false;

		const finish = (available: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			server.removeAllListeners();
			if (server.listening) {
				server.close(() => resolve(available));
				return;
			}
			resolve(available);
		};

		server.once("error", () => finish(false));
		server.once("listening", () => finish(true));
		server.listen(port, "127.0.0.1");
	});
}

function isTcpPortAvailableByLsof(port: number): boolean | undefined {
	try {
		const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});

		return output.trim().length === 0;
	} catch (error) {
		if (isNodeError(error) && error.status === 1) {
			return true;
		}

		return undefined;
	}
}

async function resolvePort(
	base: number,
	offset: number,
	isPortAvailable: (port: number) => boolean | Promise<boolean>,
): Promise<number> {
	let candidate = base + offset;
	for (let fallback = 0; fallback < 10; fallback += 1) {
		if (await isPortAvailable(candidate)) {
			return candidate;
		}
		candidate += 1;
	}

	return base;
}

function resolveWorktreeName(cwd: string): string {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();

		if (root) {
			return basename(root);
		}
	} catch {
		// Fall back to the current directory name outside git worktrees.
	}

	return basename(cwd);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { status?: number } {
	return error instanceof Error;
}
