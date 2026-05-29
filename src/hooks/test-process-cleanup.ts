import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface TestProcessCleanupResult {
	command: string | null;
	matched: boolean;
	killedPids: number[];
}

export interface TestProcessCandidate {
	pid: number;
	cwd?: string;
}

export interface EvaluateTestProcessCleanupOptions {
	listProcesses?: () => TestProcessCandidate[];
	listPids?: () => number[];
	killPid?: (pid: number) => boolean;
	currentPid?: number;
	parentPid?: number;
	cwd?: string;
}

export function evaluateTestProcessCleanup(
	payload: { toolName?: string; toolInput?: unknown; cwd?: string },
	options: EvaluateTestProcessCleanupOptions = {},
): TestProcessCleanupResult {
	const command = extractCommand(payload.toolInput);
	const matched = payload.toolName === "Bash" && command !== null && isTestCommand(command);

	if (!matched) {
		return { command, matched: false, killedPids: [] };
	}

	const currentPid = options.currentPid ?? process.pid;
	const parentPid = options.parentPid ?? process.ppid;
	const targetCwd = normalizeCwd(
		options.cwd ??
			payload.cwd ??
			(options.listProcesses || options.listPids ? undefined : process.cwd()),
	);
	const listProcesses = options.listProcesses ?? makeProcessLister(options.listPids);
	const killPid = options.killPid ?? killProcess;
	const killedPids: number[] = [];

	for (const processCandidate of listProcesses()) {
		const pid = processCandidate.pid;
		if (pid === currentPid || pid === parentPid) {
			continue;
		}

		if (targetCwd && normalizeCwd(processCandidate.cwd) !== targetCwd) {
			continue;
		}

		if (killPid(pid)) {
			killedPids.push(pid);
		}
	}

	return { command, matched: true, killedPids };
}

function extractCommand(toolInput: unknown): string | null {
	if (!isRecord(toolInput) || typeof toolInput.command !== "string") {
		return null;
	}

	return toolInput.command;
}

function isTestCommand(command: string): boolean {
	return /\b(?:pnpm|npm|npx|yarn)\s+(?:test|vitest)\b|\bvitest\b/.test(command);
}

function normalizeCwd(cwd: string | undefined): string | undefined {
	return cwd ? resolve(cwd) : undefined;
}

function makeProcessLister(listPids?: () => number[]): () => TestProcessCandidate[] {
	if (listPids) {
		return () => listPids().map((pid) => ({ pid }));
	}

	return listVitestProcesses;
}

function listVitestProcesses(): TestProcessCandidate[] {
	return listVitestPids().map((pid) => ({
		pid,
		cwd: readProcessCwd(pid),
	}));
}

function listVitestPids(): number[] {
	try {
		return execFileSync("pgrep", ["-f", "node.*vitest"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.map((line) => Number(line.trim()))
			.filter(Number.isInteger);
	} catch {
		return [];
	}
}

function readProcessCwd(pid: number): string | undefined {
	try {
		const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});

		return output
			.split("\n")
			.find((line) => line.startsWith("n") && line.length > 1)
			?.slice(1);
	} catch {
		return undefined;
	}
}

function killProcess(pid: number): boolean {
	try {
		process.kill(pid);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
