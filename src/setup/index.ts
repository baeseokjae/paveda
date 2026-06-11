import { constants, accessSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { type RuntimeSmokeResult, runRuntimeSmoke } from "../checks/runtime-smoke.js";
import type { DoctorResult } from "../doctor/index.js";
import type { HostSkillBundleTarget } from "../host-bundles/index.js";
import { parseHostSkillBundleTarget } from "../host-bundles/index.js";
import { type InitResult, initializePaveda } from "../init/index.js";
import type { StoreScope } from "../store/index.js";

export type SetupMode = "lite" | "managed";
export type SetupStatus = "ready" | "partial" | "blocked";

export interface SetupOptions {
	cwd?: string;
	host?: HostSkillBundleTarget | string;
	all?: boolean;
	mode?: SetupMode | string;
	write?: boolean;
	targetRoot?: string;
	storeScope?: StoreScope;
	dbPath?: string;
	env?: NodeJS.ProcessEnv;
}

export interface SetupHostResult {
	host: HostSkillBundleTarget;
	mode: SetupMode;
	detected: boolean;
	installed: boolean;
	init: InitResult;
	doctor: DoctorResult;
	runtimeSmoke: RuntimeSmokeResult | null;
}

export interface SetupResult {
	status: SetupStatus;
	cwd: string;
	dryRun: boolean;
	mode: SetupMode;
	detectedHosts: HostSkillBundleTarget[];
	installedHosts: HostSkillBundleTarget[];
	hosts: SetupHostResult[];
	doctor: DoctorResult | null;
	runtimeSmoke: RuntimeSmokeResult | null;
	nextCommand: string;
}

const HOST_BINARIES: Record<HostSkillBundleTarget, string[]> = {
	harness: [],
	"claude-code": ["claude"],
	codex: ["codex"],
	pi: ["pi"],
	hermes: ["hermes"],
};

export function runSetup(options: SetupOptions = {}): SetupResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const mode = parseSetupMode(options.mode);
	const env = options.env ?? process.env;
	const detectedHosts = detectHostBinaries(env);
	const hosts = selectSetupHosts({ host: options.host, all: options.all, detectedHosts });
	const hostResults = hosts.map((host) => runSetupForHost(host, { ...options, cwd, mode, env }));
	const installedHosts = hostResults
		.filter((result) => result.installed)
		.map((result) => result.host);
	const primary = hostResults[0] ?? null;
	const status = summarizeSetupStatus(hostResults, Boolean(options.write));

	return {
		status,
		cwd,
		dryRun: !options.write,
		mode,
		detectedHosts,
		installedHosts,
		hosts: hostResults,
		doctor: primary?.doctor ?? null,
		runtimeSmoke: primary?.runtimeSmoke ?? null,
		nextCommand: buildSetupNextCommand(cwd, primary?.host ?? "codex", Boolean(options.write)),
	};
}

function runSetupForHost(
	host: HostSkillBundleTarget,
	options: SetupOptions & { cwd: string; mode: SetupMode; env: NodeJS.ProcessEnv },
): SetupHostResult {
	const init = initializePaveda({
		cwd: options.cwd,
		host,
		targetRoot: options.targetRoot,
		write: Boolean(options.write),
		force: Boolean(options.write),
		includeOptional: options.mode === "managed",
	});
	const runtimeSmoke = options.write
		? runRuntimeSmoke({
				cwd: options.cwd,
				dbPath: options.dbPath,
				storeScope: options.storeScope,
				env: options.env,
			})
		: null;
	return {
		host,
		mode: options.mode,
		detected: detectHost(host, options.env),
		installed: Boolean(options.write && init.written),
		init,
		doctor: init.doctor,
		runtimeSmoke,
	};
}

function detectHostBinaries(env: NodeJS.ProcessEnv): HostSkillBundleTarget[] {
	return (["codex", "claude-code", "pi", "hermes"] as const).filter((host) =>
		detectHost(host, env),
	);
}

function detectHost(host: HostSkillBundleTarget, env: NodeJS.ProcessEnv): boolean {
	if (host === "harness") {
		return true;
	}
	return HOST_BINARIES[host].some((binary) => executableInPath(binary, env.PATH ?? ""));
}

function executableInPath(binary: string, pathValue: string): boolean {
	for (const entry of pathValue.split(delimiter).filter(Boolean)) {
		try {
			accessSync(join(entry, binary), constants.X_OK);
			return true;
		} catch {
			// Keep scanning PATH.
		}
	}
	return false;
}

function selectSetupHosts(input: {
	host?: HostSkillBundleTarget | string;
	all?: boolean;
	detectedHosts: readonly HostSkillBundleTarget[];
}): HostSkillBundleTarget[] {
	if (input.host) {
		return [parseHostSkillBundleTarget(input.host)];
	}
	if (input.all) {
		return input.detectedHosts.length > 0 ? [...input.detectedHosts] : ["codex"];
	}
	return [input.detectedHosts[0] ?? "codex"];
}

function parseSetupMode(value: SetupOptions["mode"]): SetupMode {
	if (value === undefined) {
		return "lite";
	}
	if (value === "lite" || value === "managed") {
		return value;
	}
	throw new Error(`Invalid setup mode: ${String(value)}`);
}

function summarizeSetupStatus(hosts: readonly SetupHostResult[], write: boolean): SetupStatus {
	if (!write) {
		return "partial";
	}
	if (hosts.length === 0) {
		return "blocked";
	}
	if (hosts.every((host) => host.doctor.ok && (host.runtimeSmoke?.ok ?? false))) {
		return "ready";
	}
	return hosts.some((host) => host.doctor.ok) ? "partial" : "blocked";
}

function buildSetupNextCommand(cwd: string, host: HostSkillBundleTarget, write: boolean): string {
	if (!write) {
		return `paveda setup --host ${host} --cwd ${shellQuote(cwd)} --write`;
	}
	return `paveda do --host ${host} --cwd ${shellQuote(cwd)} "describe the task"`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
