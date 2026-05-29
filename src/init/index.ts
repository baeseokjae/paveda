import { join } from "node:path";
import type { HookProfile } from "../core/index.js";
import { type DoctorResult, runDoctor } from "../doctor/index.js";
import {
	type HostSkillBundleTarget,
	type InstallHostSkillBundleResult,
	installHostSkillBundle,
	parseHostSkillBundleTarget,
} from "../host-bundles/index.js";
import {
	type InstallClaudeCodeResult,
	assertClaudeCodeSettingsPathIsSafe,
	installClaudeCode,
} from "../install/claude-code.js";

export interface InitOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	targetRoot?: string;
	skills?: string[];
	builtinRoots?: string[];
	write?: boolean;
	force?: boolean;
	cliPath?: string;
	profile?: HookProfile;
	disabledHooks?: string;
	projectHooks?: boolean;
	sessionStartContext?: boolean;
	sessionStartMaxChars?: number;
}

export interface InitResult {
	cwd: string;
	host: HostSkillBundleTarget;
	written: boolean;
	force: boolean;
	bundle: InstallHostSkillBundleResult;
	claudeCode?: InstallClaudeCodeResult;
	doctor: DoctorResult;
	nextCommands: InitNextCommand[];
}

export interface InitNextCommand {
	name: string;
	command: string;
	description: string;
}

interface BuildNextCommandsInput {
	cwd: string;
	host: HostSkillBundleTarget;
	write: boolean;
	force: boolean;
	skills?: string[];
	targetRoot?: string;
	cliPath?: string;
	profile?: HookProfile;
	disabledHooks?: string;
	projectHooks?: boolean;
	sessionStartContext?: boolean;
	sessionStartMaxChars?: number;
}

export function initializePaveda(options: InitOptions): InitResult {
	const cwd = options.cwd ?? process.cwd();
	const host = parseHostSkillBundleTarget(options.host);
	const claudeCodeSettingsPath = join(cwd, ".claude", "settings.json");
	if (host === "claude-code") {
		assertClaudeCodeSettingsPathIsSafe(claudeCodeSettingsPath);
	}
	const bundle = installHostSkillBundle({
		host,
		cwd,
		targetRoot: options.targetRoot,
		builtinRoots: options.builtinRoots,
		skills: options.skills,
		write: options.write,
		force: options.force,
	});
	const claudeCode =
		host === "claude-code"
			? installClaudeCode({
					path: claudeCodeSettingsPath,
					cliPath: options.cliPath,
					profile: options.profile,
					disabledHooks: options.disabledHooks,
					projectHooks: options.projectHooks,
					sessionStartContext: options.sessionStartContext,
					sessionStartMaxChars: options.sessionStartMaxChars,
					write: options.write,
				})
			: undefined;
	const doctor = runDoctor({
		cwd,
		host,
		targetRoot: options.targetRoot,
		cliCommand: buildCliCommand(options.cliPath),
	});
	const write = Boolean(options.write);
	const force = Boolean(options.force);

	return {
		cwd,
		host,
		written: write,
		force,
		bundle,
		...(claudeCode ? { claudeCode } : {}),
		doctor,
		nextCommands: buildNextCommands({
			cwd,
			host,
			write,
			force,
			skills: options.skills,
			targetRoot: options.targetRoot,
			cliPath: options.cliPath,
			profile: options.profile,
			disabledHooks: options.disabledHooks,
			projectHooks: options.projectHooks,
			sessionStartContext: options.sessionStartContext,
			sessionStartMaxChars: options.sessionStartMaxChars,
		}),
	};
}

function buildNextCommands(input: BuildNextCommandsInput): InitNextCommand[] {
	const cli = buildCliCommand(input.cliPath);
	const cwd = shellQuote(input.cwd);
	const targetRootArg = input.targetRoot ? ` --target-root ${shellQuote(input.targetRoot)}` : "";
	const commands: InitNextCommand[] = [];

	if (!input.write) {
		const args = [
			"init",
			"--host",
			input.host,
			"--cwd",
			cwd,
			...(input.skills && input.skills.length > 0 ? ["--skills", input.skills.join(",")] : []),
			...(input.targetRoot ? ["--target-root", shellQuote(input.targetRoot)] : []),
			...(input.cliPath ? ["--cli-path", shellQuote(input.cliPath)] : []),
			...(input.profile ? ["--profile", input.profile] : []),
			...(input.disabledHooks ? ["--disabled-hooks", shellQuote(input.disabledHooks)] : []),
			...(input.projectHooks === true ? ["--project-hooks"] : []),
			...(input.projectHooks === false ? ["--no-project-hooks"] : []),
			...(input.sessionStartContext === true ? ["--session-start-context", "on"] : []),
			...(input.sessionStartContext === false ? ["--session-start-context", "off"] : []),
			...(input.sessionStartMaxChars
				? ["--session-start-max-chars", String(input.sessionStartMaxChars)]
				: []),
			"--write",
			...(input.force ? ["--force"] : []),
		];
		commands.push({
			name: "write-init",
			command: `${cli} ${args.join(" ")}`,
			description: "Write the host bundle after reviewing the dry-run output.",
		});
	}

	commands.push(
		{
			name: "doctor",
			command: `${cli} doctor --host ${input.host} --cwd ${cwd}${targetRootArg}`,
			description: "Verify host bundle files, routed /do metadata, and host-specific settings.",
		},
		{
			name: "skills-status",
			command: `${cli} skills status --host ${input.host} --cwd ${cwd}${targetRootArg}`,
			description: "Confirm installed host skills are selected from project scope.",
		},
		{
			name: "route-do",
			command: `${cli} route --host ${input.host} --cwd ${cwd}${targetRootArg} --skill do --ambiguity-score 0.25`,
			description: "Exercise /do router metadata and ambiguity blocking.",
		},
		{
			name: "runtime-smoke",
			command: `${cli} runtime-smoke --cwd ${cwd} --json`,
			description: "Write a synthetic hook session and verify EventStore replay/status.",
		},
	);

	return commands;
}

function buildCliCommand(cliPath: string | undefined): string {
	return cliPath ? `node ${shellQuote(cliPath)}` : "paveda";
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value;
	}

	return `'${value.replaceAll("'", "'\\''")}'`;
}
