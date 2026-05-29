import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectCheckOptions {
	cwd?: string;
	checksDir?: string;
	name?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export interface ProjectCheckExecution {
	name: string;
	path: string;
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface ProjectChecksResult {
	cwd: string;
	checksDir: string;
	executions: ProjectCheckExecution[];
	ok: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function runProjectChecks(options: ProjectCheckOptions = {}): ProjectChecksResult {
	const cwd = options.cwd ?? process.cwd();
	const checksDir = options.checksDir ?? join(cwd, ".harness", "checks");
	const timeoutMs = options.timeoutMs ?? parseTimeout(options.env ?? process.env);

	if (!isDirectory(checksDir)) {
		return { cwd, checksDir, executions: [], ok: true };
	}

	const checks = listExecutableChecks(checksDir, options.name);
	const executions = checks.map((path) =>
		runProjectCheck(path, { cwd, env: options.env, timeoutMs }),
	);

	return {
		cwd,
		checksDir,
		executions,
		ok: executions.every((execution) => execution.status === 0 && !execution.error),
	};
}

function listExecutableChecks(checksDir: string, name: string | undefined): string[] {
	return readdirSync(checksDir)
		.map((entry) => join(checksDir, entry))
		.filter((path) => {
			if (!isExecutableFile(path)) {
				return false;
			}

			return name ? basename(path) === name || basename(path) === `${name}.sh` : true;
		})
		.sort((left, right) => basename(left).localeCompare(basename(right)));
}

function runProjectCheck(
	path: string,
	options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): ProjectCheckExecution {
	const result = spawnSync(path, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env,
		timeout: options.timeoutMs,
	});

	return {
		name: basename(path).replace(/\.sh$/, ""),
		path,
		status: result.status,
		signal: result.signal,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error?.message,
	};
}

function parseTimeout(env: NodeJS.ProcessEnv): number {
	const parsed = Number(env.PAVEDA_PROJECT_CHECK_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function isExecutableFile(path: string): boolean {
	const stat = lstatSync(path);
	return stat.isFile() && (stat.mode & 0o111) !== 0;
}

function isDirectory(path: string): boolean {
	return existsSync(path) && lstatSync(path).isDirectory();
}
