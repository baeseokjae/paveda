import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runAdoptionReport } from "../checks/adoption-report.js";
import { runProjectChecks } from "../checks/project-checks.js";
import { runDoctor } from "../doctor/index.js";
import { type EventRecord, EventStore, type StoreScope, resolveStorePath } from "../store/index.js";

export type WorkerTask = "doctor" | "adoption-report" | "security-scan";

export interface WorkerScheduleOptions {
	cwd?: string;
	name: string;
	task: WorkerTask | string;
	schedule: string;
	host?: string;
	dbPath?: string;
	storeScope?: StoreScope;
	write?: boolean;
	now?: number;
}

export interface WorkerRunOptions {
	cwd?: string;
	name?: string;
	task?: WorkerTask | string;
	host?: string;
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface WorkerEntry {
	name: string;
	task: WorkerTask;
	schedule: string;
	host?: string;
	createdAt: number;
	updatedAt: number;
}

export interface WorkerRunResult {
	name: string;
	task: WorkerTask;
	ok: boolean;
	output: unknown;
	event: EventRecord;
}

export function scheduleWorker(options: WorkerScheduleOptions): {
	path: string;
	worker: WorkerEntry;
	written: boolean;
} {
	const cwd = resolve(options.cwd ?? process.cwd());
	const worker = {
		name: options.name,
		task: parseWorkerTask(options.task),
		schedule: options.schedule,
		...(options.host ? { host: options.host } : {}),
		createdAt: options.now ?? Date.now(),
		updatedAt: options.now ?? Date.now(),
	};
	const path = workerConfigPath(cwd);
	if (options.write) {
		const workers = listWorkerEntries(cwd).filter((item) => item.name !== worker.name);
		mkdirSync(join(cwd, ".paveda"), { recursive: true });
		writeFileSync(path, `${JSON.stringify([...workers, worker], null, 2)}\n`);
	}
	return { path, worker, written: Boolean(options.write) };
}

export function listWorkers(options: { cwd?: string } = {}): WorkerEntry[] {
	return listWorkerEntries(resolve(options.cwd ?? process.cwd()));
}

export function runWorker(options: WorkerRunOptions): WorkerRunResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const configured = options.name
		? listWorkerEntries(cwd).find((worker) => worker.name === options.name)
		: undefined;
	const task = parseWorkerTask(options.task ?? configured?.task ?? "doctor");
	const name = options.name ?? configured?.name ?? task;
	const host = options.host ?? configured?.host;
	const output = runWorkerTask({ cwd, task, host });
	const ok = readOk(output);
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const event = store.append({
			sessionId: `worker:${name}`,
			ts: options.now ?? Date.now(),
			type: "worker.run",
			payload: { name, task, ok, output },
		});
		return { name, task, ok, output, event };
	} finally {
		store.close();
	}
}

export function workerLogs(options: {
	cwd?: string;
	dbPath?: string;
	storeScope?: StoreScope;
	name?: string;
	limit?: number;
}): EventRecord[] {
	const cwd = resolve(options.cwd ?? process.cwd());
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		return store
			.replay(options.name ? `worker:${options.name}` : "worker:doctor")
			.filter((event) => event.type === "worker.run")
			.slice(-(options.limit ?? 20));
	} finally {
		store.close();
	}
}

function runWorkerTask(input: { cwd: string; task: WorkerTask; host?: string }): unknown {
	if (input.task === "doctor") {
		return runDoctor({ cwd: input.cwd, host: input.host });
	}
	if (input.task === "adoption-report") {
		return runAdoptionReport({ cwd: input.cwd, host: input.host ?? "harness" });
	}
	return runProjectChecks({ cwd: input.cwd, name: "security" });
}

function listWorkerEntries(cwd: string): WorkerEntry[] {
	const path = workerConfigPath(cwd);
	if (!existsSync(path)) {
		return [];
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(parsed) ? parsed.map(parseWorkerEntry) : [];
}

function parseWorkerEntry(value: unknown): WorkerEntry {
	if (typeof value !== "object" || value === null) {
		throw new Error("Invalid worker entry");
	}
	const entry = value as Record<string, unknown>;
	return {
		name: readString(entry.name, "worker name"),
		task: parseWorkerTask(entry.task),
		schedule: readString(entry.schedule, "worker schedule"),
		...(typeof entry.host === "string" ? { host: entry.host } : {}),
		createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
		updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
	};
}

function parseWorkerTask(value: unknown): WorkerTask {
	if (value === "doctor" || value === "adoption-report" || value === "security-scan") {
		return value;
	}
	throw new Error(`Invalid worker task: ${String(value)}`);
}

function readString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function readOk(output: unknown): boolean {
	return typeof output === "object" && output !== null && "ok" in output
		? Boolean((output as { ok?: unknown }).ok)
		: true;
}

function workerConfigPath(cwd: string): string {
	return join(cwd, ".paveda", "workers.json");
}
