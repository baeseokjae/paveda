#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { stdin } from "node:process";
import { fromClaudeCodeHookPayload } from "./adapters/claude-code/index.js";
import { fromCodexHookPayload } from "./adapters/codex/index.js";
import { fromHermesHookPayload } from "./adapters/hermes/index.js";
import { fromPiHookPayload } from "./adapters/pi/index.js";
import { runProjectChecks } from "./checks/project-checks.js";
import { loadConfig, parseHookProfile } from "./core/index.js";
import { formatDoctorReport, runDoctor } from "./doctor/index.js";
import { assertWritePathIsSafe, writeTextFileSafely } from "./fs-safety.js";
import { type DispatchHookEventInput, dispatchHookEvent } from "./hook-runtime/index.js";
import type { ProjectHookExecution } from "./hooks/project-hooks.js";
import { formatWorktreePortsAsShell, resolveWorktreePorts } from "./hooks/worktree-port.js";
import {
	installHostSkillBundle,
	parseHostSkillBundleTarget,
	resolveHostSkillRoot,
} from "./host-bundles/index.js";
import { initializePaveda } from "./init/index.js";
import { installClaudeCode } from "./install/claude-code.js";
import { installCodex } from "./install/codex.js";
import { installHermes } from "./install/hermes.js";
import { installPi } from "./install/pi.js";
import { serveMcpStdio } from "./mcp/server.js";
import {
	type AgentEvent,
	type PolicyDecision,
	type TrustedPolicyKey,
	assertSignedPolicyBundle,
	createPolicyBundle,
	createPolicyBundleArtifact,
	createPolicyBundleCacheEntry,
	fetchSignedPolicyBundle,
	signPolicyBundle,
	summarizePolicyBundle,
	verifySignedPolicyBundleWithKeyring,
} from "./policy/index.js";
import { recordRouteDecision, routeSkill } from "./router/index.js";
import {
	enableSkillRouter,
	findSkill,
	installBuiltinSkill,
	isSkillRouterEnabled,
	loadSkillStatus,
	loadSkills,
} from "./skill-loader/index.js";
import type { LoadSkillsOptions } from "./skill-loader/index.js";
import type {
	InstinctScope,
	InstinctStatus,
	RoutedSkill,
	RouterDecision,
	RouterDecisionResult,
	SessionStatus,
	SessionSummary,
	StoreScope,
} from "./store/index.js";

const args = process.argv.slice(2);
const command = args[0];

try {
	await run(command, args.slice(1));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

async function run(command: string | undefined, args: string[]): Promise<void> {
	if (!command || command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return;
	}

	if (command === "install") {
		const host = args[0];
		if (host === "codex") {
			const explicitCommand = readOption(args, "--command");
			printJson(
				installCodex({
					path: readOption(args, "--path"),
					command: explicitCommand,
					cliPath:
						readOption(args, "--cli-path") ?? (explicitCommand ? undefined : currentCliPath()),
					managed: args.includes("--managed"),
					requirementsPath: readOption(args, "--requirements-path"),
					managedDir: readOption(args, "--managed-dir"),
					allowManagedHooksOnly: !args.includes("--allow-unmanaged-hooks"),
					write: args.includes("--write"),
					force: args.includes("--force"),
				}),
			);
			return;
		}

		if (host === "hermes") {
			const explicitCommand = readOption(args, "--command");
			printJson(
				installHermes({
					configPath: readOption(args, "--config-path"),
					hookPath: readOption(args, "--hook-path"),
					command: explicitCommand,
					cliPath:
						readOption(args, "--cli-path") ?? (explicitCommand ? undefined : currentCliPath()),
					hooksAutoAccept: args.includes("--auto-accept-hooks"),
					write: args.includes("--write"),
					force: args.includes("--force"),
				}),
			);
			return;
		}

		if (host === "pi") {
			const explicitCommand = readOption(args, "--command");
			printJson(
				installPi({
					extensionPath: readOption(args, "--extension-path"),
					command: explicitCommand,
					cliPath:
						readOption(args, "--cli-path") ?? (explicitCommand ? undefined : currentCliPath()),
					write: args.includes("--write"),
					force: args.includes("--force"),
				}),
			);
			return;
		}

		if (host !== "claude-code") {
			throw new Error(`Unsupported install host: ${host ?? ""}`);
		}
		const explicitCommand = readOption(args, "--command");

		printJson(
			installClaudeCode({
				path: readOption(args, "--path"),
				command: explicitCommand,
				cliPath: readOption(args, "--cli-path") ?? (explicitCommand ? undefined : currentCliPath()),
				profile: parseOptionalHookProfile(readOption(args, "--profile")),
				disabledHooks: readOption(args, "--disabled-hooks"),
				projectHooks: parseOptionalProjectHooks(args),
				sessionStartContext: parseOptionalOnOff(readOption(args, "--session-start-context")),
				sessionStartMaxChars: parseOptionalPositiveInteger(
					readOption(args, "--session-start-max-chars"),
					"--session-start-max-chars",
				),
				write: args.includes("--write"),
			}),
		);
		return;
	}

	if (command === "init") {
		const cliPath = readOption(args, "--cli-path") ?? currentCliPath();
		const result = initializePaveda({
			host: requireOption(args, "--host"),
			cwd: readOption(args, "--cwd"),
			targetRoot: readOption(args, "--target-root"),
			skills: parseOptionalCommaList(readOption(args, "--skills")),
			includeOptional: args.includes("--include-optional"),
			write: args.includes("--write"),
			force: args.includes("--force"),
			cliPath,
			profile: parseOptionalHookProfile(readOption(args, "--profile")),
			disabledHooks: readOption(args, "--disabled-hooks"),
			projectHooks: parseOptionalProjectHooks(args),
			sessionStartContext: parseOptionalOnOff(readOption(args, "--session-start-context")),
			sessionStartMaxChars: parseOptionalPositiveInteger(
				readOption(args, "--session-start-max-chars"),
				"--session-start-max-chars",
			),
		});
		printJson(result);
		if (args.includes("--write") && !result.doctor.ok) {
			process.exitCode = 1;
		}
		return;
	}

	if (command === "skills") {
		if (args[0] === "status") {
			printJson(loadSkillStatus(readSkillLoadOptions(args)));
			return;
		}

		if (args[0] === "enable-router") {
			printJson(
				enableSkillRouter({
					name: requirePositional(args, 1, "skill name"),
					cwd: readOption(args, "--cwd"),
					write: args.includes("--write"),
					ambiguityRequired: parseOptionalNumber(
						readOption(args, "--ambiguity-required"),
						"--ambiguity-required",
					),
				}),
			);
			return;
		}

		if (args[0] === "install") {
			printJson(
				installBuiltinSkill({
					name: requirePositional(args, 1, "skill name"),
					cwd: readOption(args, "--cwd"),
					targetRoot: readOption(args, "--target-root"),
					write: args.includes("--write"),
					force: args.includes("--force"),
				}),
			);
			return;
		}

		if (args[0] === "install-bundle") {
			printJson(
				installHostSkillBundle({
					host: requireOption(args, "--host"),
					cwd: readOption(args, "--cwd"),
					targetRoot: readOption(args, "--target-root"),
					skills: parseOptionalCommaList(readOption(args, "--skills")),
					includeOptional: args.includes("--include-optional"),
					write: args.includes("--write"),
					force: args.includes("--force"),
				}),
			);
			return;
		}

		if (args[0] && !args[0].startsWith("--")) {
			throw new Error(`Unknown skills command: ${args[0]}`);
		}

		printJson(
			loadSkills(readSkillLoadOptions(args)).map((skill) => ({
				name: skill.name,
				scope: skill.scope,
				path: skill.path,
				description: skill.frontmatter.description,
				model: skill.frontmatter.model,
				router: skill.frontmatter.router,
				trigger: skill.frontmatter.trigger,
				ambiguityRequired: skill.frontmatter.ambiguityRequired,
			})),
		);
		return;
	}

	if (command === "port" || command === "ports") {
		const result = await resolveWorktreePorts({
			cwd: readOption(args, "--cwd"),
			worktreeName: readOption(args, "--name"),
		});

		if (args.includes("--json")) {
			printJson(result);
			return;
		}

		console.log(formatWorktreePortsAsShell(result));
		return;
	}

	if (command === "doctor") {
		const result = runDoctor({
			cwd: readOption(args, "--cwd"),
			host: readOption(args, "--host"),
			targetRoot: readOption(args, "--target-root"),
			cliCommand: currentCliCommand(),
			enforcement: args.includes("--enforcement"),
			policyCachePath: readOption(args, "--policy-cache"),
		});

		if (args.includes("--json")) {
			printJson(result);
		} else {
			console.log(formatDoctorReport(result));
		}

		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}

	if (command === "check" || command === "checks") {
		const result = runProjectChecks({
			cwd: readOption(args, "--cwd"),
			name: readPositional(args, 0, ["--cwd"]),
		});

		if (args.includes("--json")) {
			printJson(result);
		} else {
			printProjectChecks(result);
		}

		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}

	if (command === "mcp") {
		const subcommand = args[0];
		if (subcommand !== "serve") {
			throw new Error(`Unsupported mcp command: ${subcommand ?? ""}`);
		}
		await serveMcpStdio({
			cwd: readOption(args, "--cwd"),
			dbPath: readOption(args, "--db"),
			storeScope: parseStoreScope(readOption(args, "--store-scope")),
			sessionId: readOption(args, "--session"),
			policyCachePath: readOption(args, "--policy-cache"),
		});
		return;
	}

	if (command === "policy") {
		const subcommand = args[0];

		if (subcommand === "bundle") {
			const generatedAt = parseOptionalDate(readOption(args, "--generated-at"), "--generated-at");
			const bundle = createPolicyBundle({
				issuer: readOption(args, "--issuer"),
				generatedAt,
				version: readOption(args, "--runtime-version"),
			});
			const privateKeyPath = readOption(args, "--private-key");
			const output = privateKeyPath
				? signPolicyBundle(bundle, {
						privateKeyPem: readTextFile(privateKeyPath, "--private-key"),
						keyId: readOption(args, "--key-id"),
					})
				: createPolicyBundleArtifact(bundle);
			const writePath = readOption(args, "--write");

			writeJsonOrPrint(output, writePath);
			return;
		}

		if (subcommand === "verify") {
			const signedBundle = assertSignedPolicyBundle(
				readJsonFile(requireOption(args, "--bundle"), "--bundle"),
			);
			const result = verifySignedPolicyBundleWithKeyring(signedBundle, {
				keys: readTrustedPolicyKeys(args),
			});
			printJson(result);
			if (!result.ok) {
				process.exitCode = 1;
			}
			return;
		}

		if (subcommand === "pull") {
			const source = requireOption(args, "--source");
			const signedBundle = await fetchSignedPolicyBundle(source);
			const verification = verifySignedPolicyBundleWithKeyring(signedBundle, {
				keys: readTrustedPolicyKeys(args),
			});
			const cachePath = readOption(args, "--cache");
			const cacheEntry = createPolicyBundleCacheEntry(signedBundle, verification, { source });
			const output = {
				source,
				summary: summarizePolicyBundle(signedBundle),
				verification,
				cache: cachePath
					? {
							path: cachePath,
							written: verification.ok && args.includes("--write"),
						}
					: undefined,
			};

			if (verification.ok && cachePath && args.includes("--write")) {
				assertWritePathIsSafe(cachePath);
				writeTextFileSafely(cachePath, `${JSON.stringify(cacheEntry, null, 2)}\n`);
			}

			printJson(output);
			if (!verification.ok) {
				process.exitCode = 1;
			}
			return;
		}

		throw new Error(`Unsupported policy command: ${subcommand ?? ""}`);
	}

	if (command === "runtime-smoke") {
		const { runRuntimeSmoke } = await import("./checks/runtime-smoke.js");
		const result = runRuntimeSmoke({
			cwd: readOption(args, "--cwd"),
			dbPath: readOption(args, "--db"),
			sessionId: readOption(args, "--session"),
			storeScope: parseStoreScope(readOption(args, "--store-scope")),
		});

		if (args.includes("--json")) {
			printJson(result);
		} else {
			console.log(formatRuntimeSmoke(result));
		}

		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}

	if (command === "adoption-report") {
		const { formatAdoptionReport, runAdoptionReport } = await import("./checks/adoption-report.js");
		const result = runAdoptionReport({
			cwd: readOption(args, "--cwd"),
			host: requireOption(args, "--host"),
			targetRoot: readOption(args, "--target-root"),
			cliCommand: currentCliCommand(),
			runtimeSmoke: args.includes("--runtime-smoke"),
			dbPath: readOption(args, "--db"),
			sessionId: readOption(args, "--session"),
			storeScope: parseStoreScope(readOption(args, "--store-scope")),
			policyCachePath: readOption(args, "--policy-cache"),
		});

		if (args.includes("--json")) {
			printJson(result);
		} else {
			console.log(formatAdoptionReport(result));
		}

		if (!result.ok) {
			process.exitCode = 1;
		}
		return;
	}

	if (!isStoreBackedCommand(command)) {
		throw new Error(`Unknown command: ${command}`);
	}

	preflightStoreBackedCommand(command, args);

	const hookHost = command === "hook" ? args[0] : undefined;
	const hookConfig = command === "hook" ? loadConfig() : undefined;
	const hookDispatchInput =
		command === "hook"
			? { ...parseHookPayloadForHost(hookHost, await readHookPayload()), config: hookConfig }
			: undefined;
	const { EventStore, resolveStorePath } = await import("./store/index.js");
	const cwd = readOption(args, "--cwd") ?? readHookPayloadCwd(hookDispatchInput);
	const storeScope = parseStoreScope(readOption(args, "--store-scope"));
	const dbPath = readOption(args, "--db") ?? resolveStorePath(storeScope, cwd);
	const store = new EventStore(dbPath);

	try {
		if (command === "status") {
			const status = parseOptionalSessionStatus(readOption(args, "--status"));
			const since = parseOptionalSince(readOption(args, "--since"), Date.now());
			const sessions = store.listSessions({ status, since });
			const output = args.includes("--markdown")
				? formatStatusMarkdown(sessions)
				: JSON.stringify(sessions, null, 2);
			const writePath = readOption(args, "--write");

			if (writePath) {
				writeTextFileSafely(writePath, `${output}\n`);
			} else {
				console.log(output);
			}

			if (args.includes("--exit-code") && sessions.some((session) => session.status === "failed")) {
				process.exitCode = 1;
			}
			return;
		}

		if (command === "events") {
			const sessionId = requireOption(args, "--session");
			printJson(
				store.replay(sessionId, { since: parseOptionalSince(readOption(args, "--since")) }),
			);
			return;
		}

		if (command === "router-trace") {
			const sessionId = requireOption(args, "--session");
			printJson(
				store.routerLineage(sessionId, { since: parseOptionalSince(readOption(args, "--since")) }),
			);
			return;
		}

		if (command === "export-decisions") {
			const decisions = store.listRouterDecisions({
				skill: parseOptionalRoutedSkill(readOption(args, "--skill")),
				since: parseOptionalSince(readOption(args, "--since")),
				limit: parseOptionalPositiveInteger(readOption(args, "--limit"), "--limit"),
			});
			const candidates = decisions.map(toDecisionCandidate);
			const output = args.includes("--markdown")
				? formatDecisionCandidatesMarkdown(candidates)
				: JSON.stringify(candidates, null, 2);
			const writePath = readOption(args, "--write");

			if (writePath) {
				writeTextFileSafely(writePath, `${output}\n`);
			} else {
				console.log(output);
			}
			return;
		}

		if (command === "instincts") {
			const subcommand = readInstinctsSubcommand(args);
			if (subcommand === "list") {
				printJson(
					store.listInstincts({
						scope: parseOptionalInstinctScope(readOption(args, "--scope")),
						status: parseOptionalInstinctStatus(readOption(args, "--status")),
						includeExpired: args.includes("--include-expired"),
						limit: parseOptionalPositiveInteger(readOption(args, "--limit"), "--limit"),
					}),
				);
				return;
			}

			if (subcommand === "add") {
				printJson(
					store.appendInstinct({
						scope: parseInstinctScope(requireOption(args, "--scope")),
						pattern: requireOption(args, "--pattern"),
						evidence: readOption(args, "--evidence"),
						examples: parseOptionalJson(readOption(args, "--examples-json"), "--examples-json"),
						confidence: parseInstinctConfidence(readOption(args, "--confidence")),
						ttlExpiresAt: parseOptionalNonNegativeInteger(
							readOption(args, "--ttl-expires-at"),
							"--ttl-expires-at",
						),
						status: parseOptionalInstinctStatus(readOption(args, "--status")),
					}),
				);
				return;
			}

			if (subcommand === "set-status") {
				const id = parseRequiredPositiveInteger(readOption(args, "--id"), "--id");
				const status = parseInstinctStatus(requireOption(args, "--status"));
				const updated = store.updateInstinctStatus(id, status);
				if (!updated) {
					throw new Error(`Instinct not found: ${id}`);
				}
				printJson(updated);
				return;
			}

			throw new Error(`Unknown instincts command: ${subcommand}`);
		}

		if (command === "route") {
			const sessionId = readOption(args, "--session");
			const result = parseOptionalRouterResult(readOption(args, "--result"));
			const skillName = parseOptionalRoutedSkill(readOption(args, "--skill")) ?? "do";
			const skill = findSkill(loadSkills(readSkillLoadOptions(args)), skillName);
			const input = {
				skill: skillName,
				routerEnabled: skill ? isSkillRouterEnabled(skill) : undefined,
				ambiguityRequired: skill?.frontmatter.ambiguityRequired,
				signals: {
					toolRetries: parseOptionalNonNegativeInteger(
						readOption(args, "--tool-retries"),
						"--tool-retries",
					),
					verifyFailures: parseOptionalNonNegativeInteger(
						readOption(args, "--verify-failures"),
						"--verify-failures",
					),
					ambiguityScore: parseOptionalNumber(
						readOption(args, "--ambiguity-score"),
						"--ambiguity-score",
					),
					elapsedMinutes: parseOptionalNumber(
						readOption(args, "--elapsed-minutes"),
						"--elapsed-minutes",
					),
				},
			};

			if (sessionId) {
				printJson(recordRouteDecision(store, { ...input, sessionId, result }));
				return;
			}

			printJson(routeSkill({ ...input, history: store.routerHistory(input.skill, 20) }));
			return;
		}

		if (command === "hook") {
			const host = args[0];
			if (host !== "claude-code" && host !== "codex" && host !== "hermes" && host !== "pi") {
				throw new Error(`Unsupported hook host: ${host ?? ""}`);
			}
			if (!hookDispatchInput) {
				throw new Error("Hook payload was not parsed");
			}

			const result = dispatchHookEvent(store, hookDispatchInput);
			printJson(toHostHookResponse(host, result));
			return;
		}

		throw new Error(`Unknown command: ${command}`);
	} finally {
		store.close();
	}
}

function isStoreBackedCommand(command: string): boolean {
	return (
		command === "status" ||
		command === "events" ||
		command === "router-trace" ||
		command === "export-decisions" ||
		command === "instincts" ||
		command === "route" ||
		command === "hook"
	);
}

function preflightStoreBackedCommand(command: string, args: string[]): void {
	readOption(args, "--db");
	readOption(args, "--cwd");
	parseStoreScope(readOption(args, "--store-scope"));

	if (command === "status") {
		parseOptionalSessionStatus(readOption(args, "--status"));
		parseOptionalSince(readOption(args, "--since"), Date.now());
		const writePath = readOption(args, "--write");
		if (writePath) {
			assertWritePathIsSafe(writePath);
		}
		return;
	}

	if (command === "events" || command === "router-trace") {
		requireOption(args, "--session");
		parseOptionalSince(readOption(args, "--since"));
		return;
	}

	if (command === "export-decisions") {
		parseOptionalRoutedSkill(readOption(args, "--skill"));
		parseOptionalSince(readOption(args, "--since"));
		parseOptionalPositiveInteger(readOption(args, "--limit"), "--limit");
		const writePath = readOption(args, "--write");
		if (writePath) {
			assertWritePathIsSafe(writePath);
		}
		return;
	}

	if (command === "instincts") {
		const subcommand = readInstinctsSubcommand(args);
		if (subcommand === "list") {
			parseOptionalInstinctScope(readOption(args, "--scope"));
			parseOptionalInstinctStatus(readOption(args, "--status"));
			parseOptionalPositiveInteger(readOption(args, "--limit"), "--limit");
			return;
		}
		if (subcommand === "add") {
			parseInstinctScope(requireOption(args, "--scope"));
			requireOption(args, "--pattern");
			readOption(args, "--evidence");
			parseOptionalJson(readOption(args, "--examples-json"), "--examples-json");
			parseInstinctConfidence(readOption(args, "--confidence"));
			parseOptionalNonNegativeInteger(readOption(args, "--ttl-expires-at"), "--ttl-expires-at");
			parseOptionalInstinctStatus(readOption(args, "--status"));
			return;
		}
		if (subcommand === "set-status") {
			parseRequiredPositiveInteger(readOption(args, "--id"), "--id");
			parseInstinctStatus(requireOption(args, "--status"));
			return;
		}
		throw new Error(`Unknown instincts command: ${subcommand}`);
	}

	if (command === "route") {
		readOption(args, "--session");
		parseOptionalRouterResult(readOption(args, "--result"));
		parseOptionalRoutedSkill(readOption(args, "--skill"));
		readOption(args, "--target-root");
		parseOptionalNonNegativeInteger(readOption(args, "--tool-retries"), "--tool-retries");
		parseOptionalNonNegativeInteger(readOption(args, "--verify-failures"), "--verify-failures");
		parseOptionalNumber(readOption(args, "--ambiguity-score"), "--ambiguity-score");
		parseOptionalNumber(readOption(args, "--elapsed-minutes"), "--elapsed-minutes");
		if (args.includes("--host")) {
			parseHostSkillBundleTarget(requireOption(args, "--host"));
		}
		return;
	}

	if (command === "hook") {
		const host = args[0];
		if (host !== "claude-code" && host !== "codex" && host !== "hermes" && host !== "pi") {
			throw new Error(`Unsupported hook host: ${host ?? ""}`);
		}
	}
}

function readOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) {
		return undefined;
	}

	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for option: ${name}`);
	}

	return value;
}

function requireOption(args: string[], name: string): string {
	const value = readOption(args, name);
	if (!value) {
		throw new Error(`Missing required option: ${name}`);
	}

	return value;
}

function requirePositional(args: string[], index: number, label: string): string {
	const value = args[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing required ${label}`);
	}

	return value;
}

function readPositional(
	args: string[],
	index: number,
	optionsWithValues: readonly string[] = [],
): string | undefined {
	const values: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) {
			continue;
		}
		if (optionsWithValues.includes(arg)) {
			i += 1;
			continue;
		}
		if (!arg.startsWith("--")) {
			values.push(arg);
		}
	}

	return values[index];
}

function parseOptionalHookProfile(value: string | undefined) {
	return value ? parseHookProfile(value) : undefined;
}

function parseOptionalProjectHooks(args: string[]): boolean | undefined {
	if (args.includes("--project-hooks")) {
		return true;
	}

	if (args.includes("--no-project-hooks")) {
		return false;
	}

	return undefined;
}

function parseOptionalOnOff(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "on") {
		return true;
	}
	if (value === "off") {
		return false;
	}
	throw new Error(`Expected on or off: ${value}`);
}

function parseOptionalCommaList(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function readSkillLoadOptions(args: string[]): LoadSkillsOptions {
	const cwd = readOption(args, "--cwd");
	if (!args.includes("--host")) {
		return { cwd };
	}

	const host = requireOption(args, "--host");
	const targetRoot = readOption(args, "--target-root");
	return {
		cwd,
		projectRoots: [resolveHostSkillRoot(host, cwd ?? process.cwd(), targetRoot)],
	};
}

function readInstinctsSubcommand(args: string[]): string {
	const candidate = args[0];
	return !candidate || candidate.startsWith("--") ? "list" : candidate;
}

function readHookPayloadCwd(input: DispatchHookEventInput | undefined): string | undefined {
	const payload = input?.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return undefined;
	}

	const cwd = (payload as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}

	return parsed;
}

function parseRequiredPositiveInteger(value: string | undefined, name: string): number {
	const parsed = parseOptionalPositiveInteger(value, name);
	if (parsed === undefined) {
		throw new Error(`Missing required option: ${name}`);
	}

	return parsed;
}

function parseOptionalNonNegativeInteger(
	value: string | undefined,
	name: string,
): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative integer`);
	}

	return parsed;
}

function parseOptionalNumber(value: string | undefined, name: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${name} must be a number`);
	}

	return parsed;
}

function parseRequiredNumber(value: string | undefined, name: string): number {
	const parsed = parseOptionalNumber(value, name);
	if (parsed === undefined) {
		throw new Error(`Missing required option: ${name}`);
	}

	return parsed;
}

function parseInstinctConfidence(value: string | undefined): number {
	const parsed = parseRequiredNumber(value, "--confidence");
	if (parsed < 0 || parsed > 1) {
		throw new Error("--confidence must be between 0 and 1");
	}

	return parsed;
}

function parseOptionalRouterResult(value: string | undefined): RouterDecisionResult | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === "success" || value === "retry" || value === "abort") {
		return value;
	}

	throw new Error(`Invalid router result: ${value}`);
}

function parseOptionalRoutedSkill(value: string | undefined): RoutedSkill | undefined {
	if (value === undefined || value === "do") {
		return value;
	}

	throw new Error("PAL Router is only enabled for /do");
}

function parseOptionalSessionStatus(value: string | undefined): SessionStatus | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (value === "active" || value === "completed" || value === "failed" || value === "compacted") {
		return value;
	}

	throw new Error(`Invalid --status value: ${value}`);
}

function parseOptionalInstinctScope(value: string | undefined): InstinctScope | undefined {
	return value === undefined ? undefined : parseInstinctScope(value);
}

function parseInstinctScope(value: string): InstinctScope {
	if (value === "project" || value === "user") {
		return value;
	}

	throw new Error(`Invalid instinct scope: ${value}`);
}

function parseOptionalInstinctStatus(value: string | undefined): InstinctStatus | undefined {
	return value === undefined ? undefined : parseInstinctStatus(value);
}

function parseInstinctStatus(value: string): InstinctStatus {
	if (value === "pending" || value === "active" || value === "promoted" || value === "expired") {
		return value;
	}

	throw new Error(`Invalid instinct status: ${value}`);
}

function parseStoreScope(value: string | undefined): StoreScope {
	if (value === undefined || value === "project") {
		return "project";
	}

	if (value === "user") {
		return "user";
	}

	throw new Error(`Invalid --store-scope value: ${value}`);
}

function parseOptionalJson(value: string | undefined, name: string): unknown {
	if (value === undefined) {
		return undefined;
	}

	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new Error(`${name} must be valid JSON`);
	}
}

function parseOptionalDate(value: string | undefined, name: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (!Number.isFinite(Date.parse(value))) {
		throw new Error(`${name} must be a valid date`);
	}

	return value;
}

function parseOptionalSince(value: string | undefined, now = Date.now()): number | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (/^\d+$/.test(value)) {
		return Number(value);
	}

	const relative = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
	if (relative) {
		const amount = Number(relative[1]);
		const unit = relative[2];
		const multiplier =
			unit === "ms"
				? 1
				: unit === "s"
					? 1000
					: unit === "m"
						? 60_000
						: unit === "h"
							? 3_600_000
							: 86_400_000;
		return now - amount * multiplier;
	}

	const parsed = Date.parse(value);
	if (Number.isFinite(parsed)) {
		return parsed;
	}

	throw new Error(`Invalid --since value: ${value}`);
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function writeJsonOrPrint(value: unknown, writePath: string | undefined): void {
	const output = `${JSON.stringify(value, null, 2)}\n`;
	if (writePath) {
		assertWritePathIsSafe(writePath);
		writeTextFileSafely(writePath, output);
		return;
	}

	process.stdout.write(output);
}

function readTextFile(path: string, name: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read ${name}: ${message}`);
	}
}

function readJsonFile(path: string, name: string): unknown {
	try {
		return JSON.parse(readTextFile(path, name)) as unknown;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`${name} must be valid JSON`);
		}
		throw error;
	}
}

function readTrustedPolicyKeys(args: string[]): TrustedPolicyKey[] {
	const keyringPath = readOption(args, "--keyring");
	if (keyringPath) {
		return parsePolicyKeyring(readJsonFile(keyringPath, "--keyring"));
	}

	const publicKeyPath = readOption(args, "--public-key");
	if (!publicKeyPath) {
		throw new Error("Missing required option: --public-key or --keyring");
	}

	const keyId = readOption(args, "--key-id");
	return [
		{
			publicKeyPem: readTextFile(publicKeyPath, "--public-key"),
			...(keyId ? { keyId } : {}),
		},
	];
}

function parsePolicyKeyring(value: unknown): TrustedPolicyKey[] {
	if (!isRecord(value) || !Array.isArray(value.keys)) {
		throw new Error("--keyring must be a JSON object with a keys array");
	}

	return value.keys.map((key, index) => {
		if (!isRecord(key) || typeof key.publicKeyPem !== "string") {
			throw new Error(`--keyring keys[${index}] must include publicKeyPem`);
		}
		if (key.keyId !== undefined && typeof key.keyId !== "string") {
			throw new Error(`--keyring keys[${index}].keyId must be a string`);
		}

		return {
			publicKeyPem: key.publicKeyPem,
			...(key.keyId ? { keyId: key.keyId } : {}),
		};
	});
}

function formatStatusMarkdown(sessions: readonly SessionSummary[]): string {
	const lines = ["# Paveda Session Status", ""];

	if (sessions.length === 0) {
		return [...lines, "No sessions found."].join("\n");
	}

	lines.push("| Session | Status | Started | Ended | Tool Calls | Agent Spawns | Cost USD |");
	lines.push("|---|---|---|---|---:|---:|---:|");

	for (const session of sessions) {
		lines.push(
			[
				escapeMarkdownCell(session.id),
				session.status,
				formatTimestamp(session.startedAt),
				session.endedAt === null ? "" : formatTimestamp(session.endedAt),
				String(session.toolCalls),
				String(session.agentSpawns),
				session.costUsd.toFixed(4),
			]
				.join(" | ")
				.replace(/^/, "| ")
				.replace(/$/, " |"),
		);
	}

	return lines.join("\n");
}

interface DecisionCandidate {
	id: string;
	title: string;
	sessionId: string;
	timestamp: string;
	skill: string;
	tier: string;
	reason: string | null;
	result: string | null;
	source: {
		type: "router_decision";
		id: number;
	};
}

function toDecisionCandidate(decision: RouterDecision): DecisionCandidate {
	return {
		id: `router-decision-${decision.id}`,
		title: `${decision.skill}: ${decision.tier}${decision.result ? ` -> ${decision.result}` : ""}`,
		sessionId: decision.sessionId,
		timestamp: formatTimestamp(decision.ts),
		skill: decision.skill,
		tier: decision.tier,
		reason: decision.reason,
		result: decision.result,
		source: {
			type: "router_decision",
			id: decision.id,
		},
	};
}

function formatDecisionCandidatesMarkdown(candidates: readonly DecisionCandidate[]): string {
	const lines = ["# Paveda Decision Candidates", ""];

	if (candidates.length === 0) {
		return [...lines, "No decision candidates found."].join("\n");
	}

	for (const candidate of candidates) {
		lines.push(`## ${candidate.title}`);
		lines.push("");
		lines.push(`- id: ${candidate.id}`);
		lines.push(`- session: ${candidate.sessionId}`);
		lines.push(`- timestamp: ${candidate.timestamp}`);
		lines.push(`- skill: ${candidate.skill}`);
		lines.push(`- tier: ${candidate.tier}`);
		lines.push(`- result: ${candidate.result ?? ""}`);
		lines.push(`- reason: ${candidate.reason ?? ""}`);
		lines.push(`- source: router_decisions#${candidate.source.id}`);
		lines.push("");
	}

	return lines.join("\n").trimEnd();
}

function formatTimestamp(value: number): string {
	return new Date(value).toISOString();
}

function escapeMarkdownCell(value: string): string {
	return value.replaceAll("|", "\\|");
}

function printProjectChecks(value: ReturnType<typeof runProjectChecks>): void {
	if (value.executions.length === 0) {
		console.log(`No project checks found in ${value.checksDir}`);
		return;
	}

	for (const execution of value.executions) {
		if (execution.stdout) {
			process.stdout.write(execution.stdout);
		}
		if (execution.stderr) {
			process.stderr.write(execution.stderr);
		}
		if (execution.status !== 0 || execution.error) {
			console.error(
				`Project check failed: ${execution.name}${execution.error ? ` (${execution.error})` : ""}`,
			);
		}
	}
}

function formatRuntimeSmoke(value: {
	ok: boolean;
	cwd: string;
	dbPath: string;
	sessionId: string;
	eventCount: number;
	eventTypes: string[];
	summary: { status: string; toolCalls: number } | null;
	checks: Array<{ name: string; status: string; message: string }>;
}): string {
	const lines = [
		"Paveda Runtime Smoke",
		`cwd: ${value.cwd}`,
		`db: ${value.dbPath}`,
		`session: ${value.sessionId}`,
		`status: ${value.ok ? "ok" : "failed"}`,
		`events: ${value.eventCount}`,
		`event types: ${value.eventTypes.join(", ")}`,
		`summary: ${value.summary ? `${value.summary.status}, toolCalls=${value.summary.toolCalls}` : "missing"}`,
		"",
	];

	for (const check of value.checks) {
		lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
	}

	return lines.join("\n");
}

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		stdin.setEncoding("utf8");
		stdin.on("data", (chunk) => {
			data += chunk;
		});
		stdin.on("end", () => resolve(data));
		stdin.on("error", reject);
	});
}

async function readHookPayload(): Promise<Record<string, unknown>> {
	const payload = JSON.parse(await readStdin()) as unknown;
	if (!isRecord(payload)) {
		throw new Error("Hook payload must be a JSON object");
	}

	return payload;
}

function parseHookPayloadForHost(
	host: string | undefined,
	payload: Record<string, unknown>,
): DispatchHookEventInput {
	if (host === "claude-code") {
		return fromClaudeCodeHookPayload(payload);
	}

	if (host === "codex") {
		return fromCodexHookPayload(payload);
	}

	if (host === "hermes") {
		return fromHermesHookPayload(payload);
	}

	if (host === "pi") {
		return fromPiHookPayload(payload);
	}

	throw new Error(`Unsupported hook host: ${host ?? ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toClaudeCodeHookResponse(value: ReturnType<typeof dispatchHookEvent>): unknown {
	if (value.sessionContext) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: value.sessionContext.additionalContext,
			},
		};
	}

	const blockingDecision = pickPolicyDecision(value.policyEvaluation?.decisions, "deny");
	if (blockingDecision?.enforced) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toClaudeCodeHookEventName(value.agentEvent, "PreToolUse"),
				permissionDecision: "deny",
				permissionDecisionReason: blockingDecision.reason,
			},
		};
	}

	const askDecision = pickPolicyDecision(value.policyEvaluation?.decisions, "ask");
	if (askDecision) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toClaudeCodeHookEventName(value.agentEvent, "PreToolUse"),
				permissionDecision: "ask",
				permissionDecisionReason: askDecision.reason,
			},
		};
	}

	const requiredStepDecision = pickPolicyDecision(
		value.policyEvaluation?.decisions,
		"require_step",
	);
	if (requiredStepDecision) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toClaudeCodeHookEventName(value.agentEvent, "PreToolUse"),
				additionalContext: requiredStepDecision.reason,
			},
		};
	}

	const projectHookResponse = pickProjectHookResponse(value.projectHooks?.executions);

	if (projectHookResponse) {
		return {
			...value,
			...projectHookResponse,
		};
	}

	const contextDecision = pickPolicyContextDecision(value.policyEvaluation?.decisions);
	if (contextDecision) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toClaudeCodeHookEventName(value.agentEvent, "PreToolUse"),
				additionalContext: contextDecision.reason,
			},
		};
	}

	if (value.destructiveGuard?.additionalContext) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: value.destructiveGuard.additionalContext,
			},
		};
	}

	if (value.blastCheck?.additionalContext) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: value.blastCheck.additionalContext,
			},
		};
	}

	return value;
}

function toHostHookResponse(
	host: "claude-code" | "codex" | "hermes" | "pi",
	value: ReturnType<typeof dispatchHookEvent>,
): unknown {
	switch (host) {
		case "claude-code":
			return toClaudeCodeHookResponse(value);
		case "codex":
			return toCodexHookResponse(value);
		case "hermes":
			return toHermesHookResponse(value);
		case "pi":
			return toPiHookResponse(value);
	}
}

function toCodexHookResponse(value: ReturnType<typeof dispatchHookEvent>): unknown {
	if (value.sessionContext) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: value.sessionContext.additionalContext,
			},
		};
	}

	const blockingDecision = pickPolicyDecision(value.policyEvaluation?.decisions, "deny");
	if (blockingDecision?.enforced) {
		return {
			...value,
			...codexBlockingOutput(value.agentEvent, blockingDecision),
		};
	}

	const requiredStepDecision = pickPolicyDecision(
		value.policyEvaluation?.decisions,
		"require_step",
	);
	if (requiredStepDecision) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toCodexHookEventName(value.agentEvent, "PostToolUse"),
				additionalContext: requiredStepDecision.reason,
			},
		};
	}

	const projectHookResponse = pickProjectHookResponse(value.projectHooks?.executions);

	if (projectHookResponse) {
		return {
			...value,
			...projectHookResponse,
		};
	}

	const contextDecision = pickPolicyContextDecision(value.policyEvaluation?.decisions);
	if (contextDecision) {
		return {
			...value,
			hookSpecificOutput: {
				hookEventName: toCodexHookEventName(value.agentEvent, "PreToolUse"),
				additionalContext: contextDecision.reason,
			},
		};
	}

	return value;
}

function toHermesHookResponse(value: ReturnType<typeof dispatchHookEvent>): unknown {
	const blockingDecision = pickPolicyDecision(value.policyEvaluation?.decisions, "deny");
	if (blockingDecision?.enforced) {
		return {
			...value,
			action: "block",
			message: blockingDecision.reason,
			decision: "block",
			reason: blockingDecision.reason,
		};
	}

	const requiredStepDecision = pickPolicyDecision(
		value.policyEvaluation?.decisions,
		"require_step",
	);
	if (requiredStepDecision) {
		return {
			...value,
			context: requiredStepDecision.reason,
		};
	}

	const contextDecision = pickPolicyContextDecision(value.policyEvaluation?.decisions);
	if (contextDecision) {
		return {
			...value,
			context: contextDecision.reason,
		};
	}

	return value;
}

function toPiHookResponse(value: ReturnType<typeof dispatchHookEvent>): unknown {
	const blockingDecision = pickPolicyDecision(value.policyEvaluation?.decisions, "deny");
	if (blockingDecision?.enforced) {
		return {
			...value,
			block: true,
			reason: blockingDecision.reason,
		};
	}

	const requiredStepDecision = pickPolicyDecision(
		value.policyEvaluation?.decisions,
		"require_step",
	);
	if (requiredStepDecision) {
		return {
			...value,
			message: piPolicyMessage(requiredStepDecision),
		};
	}

	const contextDecision = pickPolicyContextDecision(value.policyEvaluation?.decisions);
	if (contextDecision) {
		return {
			...value,
			message: piPolicyMessage(contextDecision),
		};
	}

	return value;
}

function piPolicyMessage(decision: PolicyDecision): Record<string, unknown> {
	return {
		customType: "paveda-policy",
		content: decision.reason,
		display: true,
	};
}

function pickPolicyDecision(
	decisions: readonly PolicyDecision[] | undefined,
	action: PolicyDecision["action"],
): PolicyDecision | undefined {
	return decisions?.find((decision) => decision.action === action);
}

function pickPolicyContextDecision(
	decisions: readonly PolicyDecision[] | undefined,
): PolicyDecision | undefined {
	return decisions?.find(
		(decision) => decision.action === "warn" || decision.action === "record_only",
	);
}

function toClaudeCodeHookEventName(
	event: AgentEvent | undefined,
	fallback: "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop",
): "SessionStart" | "PreToolUse" | "PostToolUse" | "Stop" {
	if (!event) {
		return fallback;
	}

	switch (event.kind) {
		case "session.started":
			return "SessionStart";
		case "tool.requested":
		case "file.mutated":
		case "prompt.submitted":
			return "PreToolUse";
		case "tool.completed":
		case "verification.completed":
			return "PostToolUse";
		case "session.stopped":
			return "Stop";
	}
}

function codexBlockingOutput(
	event: AgentEvent | undefined,
	decision: PolicyDecision,
): Record<string, unknown> {
	const hookEventName = readHookEventName(event) ?? toCodexHookEventName(event, "PreToolUse");

	if (hookEventName === "PermissionRequest") {
		return {
			hookSpecificOutput: {
				hookEventName,
				decision: {
					behavior: "deny",
					message: decision.reason,
				},
			},
		};
	}

	if (hookEventName === "PreToolUse") {
		return {
			hookSpecificOutput: {
				hookEventName,
				permissionDecision: "deny",
				permissionDecisionReason: decision.reason,
			},
		};
	}

	return {
		decision: "block",
		reason: decision.reason,
		hookSpecificOutput: {
			hookEventName,
			additionalContext: decision.reason,
		},
	};
}

function toCodexHookEventName(
	event: AgentEvent | undefined,
	fallback: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop",
): "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" {
	const rawHookEventName = readHookEventName(event);
	if (
		rawHookEventName === "SessionStart" ||
		rawHookEventName === "UserPromptSubmit" ||
		rawHookEventName === "PreToolUse" ||
		rawHookEventName === "PostToolUse" ||
		rawHookEventName === "Stop"
	) {
		return rawHookEventName;
	}

	if (!event) {
		return fallback;
	}

	switch (event.kind) {
		case "session.started":
			return "SessionStart";
		case "prompt.submitted":
			return "UserPromptSubmit";
		case "tool.requested":
		case "file.mutated":
			return "PreToolUse";
		case "tool.completed":
		case "verification.completed":
			return "PostToolUse";
		case "session.stopped":
			return "Stop";
	}
}

function readHookEventName(event: AgentEvent | undefined): string | undefined {
	if (!event || !isRecord(event.raw)) {
		return undefined;
	}

	const rawHookEventName = event.raw.hookEventName;
	return typeof rawHookEventName === "string" ? rawHookEventName : undefined;
}

function pickProjectHookResponse(
	executions: ProjectHookExecution[] | undefined,
): Record<string, unknown> | undefined {
	if (!Array.isArray(executions)) {
		return undefined;
	}

	for (const execution of executions) {
		if (isRecord(execution.response) && typeof execution.response.decision === "string") {
			return execution.response;
		}
	}

	for (const execution of executions) {
		if (isRecord(execution.response) && isRecord(execution.response.hookSpecificOutput)) {
			return execution.response;
		}
	}

	return undefined;
}

function currentCliPath(): string | undefined {
	return process.argv[1];
}

function currentCliCommand(): string {
	const cliPath = currentCliPath();
	return cliPath ? `node ${shellQuote(cliPath)}` : "paveda";
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value;
	}

	return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp(): void {
	console.log(`paveda <command> [options]

Portable policy runtime for agent workflows, host adapters, signed bundles, routing, and checks.

Hosts:
  harness | claude-code | codex | pi | hermes

Common flow:
  init --host harness|claude-code|codex|pi|hermes [--cwd path] [--target-root path] [--skills do,verify] [--include-optional] [--cli-path /path/to/dist/cli.js] [--profile minimal|standard|strict] [--disabled-hooks selector] [--project-hooks|--no-project-hooks] [--session-start-context on|off] [--session-start-max-chars n] [--write] [--force]
  adoption-report --host harness|claude-code|codex|pi|hermes [--cwd path] [--target-root path] [--policy-cache path] [--runtime-smoke] [--db path] [--store-scope project|user] [--session id] [--json]
  doctor [--cwd path] [--host harness|claude-code|codex|pi|hermes] [--target-root path] [--policy-cache path] [--enforcement] [--json]
  mcp serve [--cwd path] [--db path] [--store-scope project|user] [--session id] [--policy-cache path]
  skills status [--cwd path] [--host harness|claude-code|codex|pi|hermes] [--target-root path]
  route [--skill do] [--cwd path] [--host harness|claude-code|codex|pi|hermes] [--target-root path] [--session id] [--result success|retry|abort] [--tool-retries n] [--verify-failures n] [--ambiguity-score n] [--elapsed-minutes n] [--db path] [--store-scope project|user]

Host setup:
  install claude-code [--path .claude/settings.json] [--command "paveda hook claude-code"] [--cli-path /path/to/dist/cli.js] [--profile minimal|standard|strict] [--disabled-hooks selector] [--project-hooks|--no-project-hooks] [--session-start-context on|off] [--session-start-max-chars n] [--write]
  install codex [--path .codex/hooks.json] [--command "paveda hook codex"] [--cli-path /path/to/dist/cli.js] [--managed] [--requirements-path requirements.toml] [--managed-dir .codex/hooks] [--allow-unmanaged-hooks] [--write] [--force]
  install hermes [--config-path .hermes/config.yaml] [--hook-path .hermes/agent-hooks/paveda-policy.sh] [--command "paveda hook hermes"] [--cli-path /path/to/dist/cli.js] [--auto-accept-hooks] [--write] [--force]
  install pi [--extension-path .pi/extensions/paveda-policy.ts] [--command "paveda hook pi"] [--cli-path /path/to/dist/cli.js] [--write] [--force]
  skills install-bundle --host harness|claude-code|codex|pi|hermes [--cwd path] [--target-root path] [--skills do,verify] [--include-optional] [--write] [--force]

Skill management:
  skills [--cwd path] [--host harness|claude-code|codex|pi|hermes] [--target-root path]
  skills enable-router do [--cwd path] [--ambiguity-required n] [--write]
  skills install <name> [--cwd path] [--target-root path] [--write] [--force]

Runtime and reports:
  policy bundle [--issuer id] [--generated-at ISO] [--runtime-version version] [--private-key path] [--key-id id] [--write path]
  policy verify --bundle path [--public-key path --key-id id | --keyring path]
  policy pull --source path|file-url|https-url [--public-key path --key-id id | --keyring path] [--cache path] [--write]
  runtime-smoke [--cwd path] [--db path] [--store-scope project|user] [--session id] [--json]
  status [--cwd path] [--status active|completed|failed|compacted] [--since 1h|ISO|epoch-ms] [--markdown] [--write path] [--exit-code] [--db path] [--store-scope project|user]
  events --session <id> [--cwd path] [--since 1h|ISO|epoch-ms] [--db path] [--store-scope project|user]
  router-trace --session <id> [--cwd path] [--since 1h|ISO|epoch-ms] [--db path] [--store-scope project|user]
  export-decisions [--cwd path] [--skill do] [--since 1h|ISO|epoch-ms] [--limit n] [--markdown] [--write path] [--db path] [--store-scope project|user]
  instincts [list] [--scope project|user] [--status pending|active|promoted|expired] [--include-expired] [--limit n] [--db path] [--store-scope project|user]
  instincts add --scope project|user --pattern text --confidence n [--evidence text] [--examples-json json] [--ttl-expires-at epoch-ms] [--status pending|active|promoted|expired] [--db path] [--store-scope project|user]
  instincts set-status --id n --status pending|active|promoted|expired [--db path] [--store-scope project|user]
  hook claude-code|codex|hermes|pi [--cwd path] [--db path] [--store-scope project|user] < payload.json

Project utilities:
  check [name] [--cwd path] [--json]
  port [--cwd path] [--name worktree-name] [--json]

Commands that can write project files require --write.
CLI-generated follow-up and recovery commands use the current CLI path by default.
`);
}
