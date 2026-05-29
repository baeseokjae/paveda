import type {
	DisabledHookSelector,
	HookProfile,
	LifecycleEvent,
	PavedaConfig,
} from "../core/index.js";
import { loadConfig } from "../core/index.js";
import { type BlastCheckResult, evaluateBlastCheck } from "../hooks/blast-check.js";
import { type CostGuardResult, evaluateCostGuard } from "../hooks/cost-guard.js";
import {
	type DestructiveGuardResult,
	evaluateDestructiveGuard,
} from "../hooks/destructive-guard.js";
import { type ProjectHooksResult, runProjectHooks } from "../hooks/project-hooks.js";
import { type SessionContext, collectSessionContext } from "../hooks/session-context.js";
import {
	type TestProcessCleanupResult,
	evaluateTestProcessCleanup,
} from "../hooks/test-process-cleanup.js";
import { type ToolingEnforceResult, evaluateToolingEnforce } from "../hooks/tooling-enforce.js";
import type { EventRecord, EventStore } from "../store/index.js";

export interface HookDefinition {
	name: string;
	lifecycle: LifecycleEvent;
	matcher: string;
	profiles: readonly HookProfile[];
}

export interface DispatchHookEventInput {
	sessionId: string;
	lifecycle: LifecycleEvent;
	payload?: unknown;
	hookName?: string;
	matcher?: string;
	ts?: number;
	config?: PavedaConfig;
	projectHooks?: boolean;
}

export interface DispatchHookEventResult {
	dispatched: boolean;
	reason?: "disabled";
	hook: HookDefinition;
	events: EventRecord[];
	sessionContext?: SessionContext;
	costGuard?: CostGuardResult;
	destructiveGuard?: DestructiveGuardResult;
	blastCheck?: BlastCheckResult;
	toolingEnforce?: ToolingEnforceResult;
	testProcessCleanup?: TestProcessCleanupResult;
	projectHooks?: ProjectHooksResult;
}

interface SessionConfigResolution {
	config: PavedaConfig;
	snapshotExists: boolean;
}

export const BUILT_IN_HOOKS: readonly HookDefinition[] = [
	{
		name: "harness.session.context",
		lifecycle: "session.created",
		matcher: "session",
		profiles: ["minimal", "standard", "strict"],
	},
	{
		name: "harness.cost.guard",
		lifecycle: "tool.execute.after",
		matcher: "Agent",
		profiles: ["standard", "strict"],
	},
	{
		name: "harness.test.process.cleanup",
		lifecycle: "tool.execute.after",
		matcher: "Bash",
		profiles: ["standard", "strict"],
	},
	{
		name: "harness.destructive.guard",
		lifecycle: "tool.execute.before",
		matcher: "Bash",
		profiles: ["minimal", "standard", "strict"],
	},
	{
		name: "harness.blast.check",
		lifecycle: "tool.execute.before",
		matcher: "Edit|Write|apply_patch",
		profiles: ["standard", "strict"],
	},
	{
		name: "harness.tooling.enforce",
		lifecycle: "tool.execute.before",
		matcher: "Bash",
		profiles: ["standard", "strict"],
	},
	{
		name: "harness.worktree.port",
		lifecycle: "hook.fired",
		matcher: "worktree-port",
		profiles: ["standard", "strict"],
	},
];

export function dispatchHookEvent(
	store: EventStore,
	input: DispatchHookEventInput,
): DispatchHookEventResult {
	const sessionConfig = resolveSessionConfig(store, input.sessionId, input.config ?? loadConfig());
	const config = sessionConfig.config;
	const hook = resolveHookDefinition(input);
	const primaryHookEnabled = isHookEnabled(hook, config);
	const destructiveGuardCompanionHook = resolveCompanionHook(input, "harness.destructive.guard");
	const destructiveGuardCompanionEnabled = destructiveGuardCompanionHook
		? isHookEnabled(destructiveGuardCompanionHook, config)
		: false;
	const toolingEnforceEnabled = shouldEvaluateCompanionHook(
		input,
		config,
		"harness.tooling.enforce",
	);
	const ts = input.ts ?? Date.now();
	const shouldSnapshotConfig =
		input.lifecycle === "session.created" && !sessionConfig.snapshotExists;

	if (!primaryHookEnabled && !destructiveGuardCompanionEnabled && !toolingEnforceEnabled) {
		const events = shouldSnapshotConfig
			? [
					store.append({
						sessionId: input.sessionId,
						ts,
						type: "config.snapshot",
						payload: toConfigSnapshot(config),
					}),
				]
			: [];
		return { dispatched: false, reason: "disabled", hook, events };
	}

	const dispatchedHook = resolveDispatchedHook({
		hook,
		primaryHookEnabled,
		destructiveGuardCompanionHook,
		destructiveGuardCompanionEnabled,
		toolingEnforceEnabled,
	});
	const projectHooksEnabled = input.projectHooks ?? config.projectHooks;
	const sessionContext =
		input.lifecycle === "session.created"
			? (collectSessionContext({ cwd: extractPayloadCwd(input.payload), config }) ?? undefined)
			: undefined;
	const payload =
		sessionContext && isRecord(input.payload)
			? { ...input.payload, sessionContext }
			: (input.payload ?? {});
	const events: EventRecord[] = [
		store.append({
			sessionId: input.sessionId,
			ts,
			type: "hook.fired",
			payload: {
				hook: dispatchedHook.name,
				lifecycle: dispatchedHook.lifecycle,
				matcher: dispatchedHook.matcher,
				profile: config.hookProfile,
			},
		}),
	];
	if (shouldSnapshotConfig) {
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "config.snapshot",
				payload: toConfigSnapshot(config),
			}),
		);
	}
	events.push(
		store.append({
			sessionId: input.sessionId,
			ts,
			type: input.lifecycle,
			payload,
		}),
	);
	if (config.hookProfile === "strict") {
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "hook.verbose",
				payload: {
					hook: hook.name,
					lifecycle: input.lifecycle,
					matcher: input.matcher,
					payloadKeys: Object.keys(payload).sort(),
					projectHooksEnabled,
				},
			}),
		);
	}
	let costGuard: CostGuardResult | undefined;
	let destructiveGuard: DestructiveGuardResult | undefined;
	let blastCheck: BlastCheckResult | undefined;
	let toolingEnforce: ToolingEnforceResult | undefined;
	let testProcessCleanup: TestProcessCleanupResult | undefined;

	if (primaryHookEnabled && hook.name === "harness.cost.guard") {
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "agent.spawned",
				payload: extractAgentSpawnPayload(input.payload),
			}),
		);
		costGuard = evaluateCostGuard(store, { sessionId: input.sessionId, ts, config });
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "cost.guard.evaluated",
				payload: costGuard,
			}),
		);
	}

	if (primaryHookEnabled && hook.name === "harness.test.process.cleanup") {
		testProcessCleanup = evaluateTestProcessCleanup(extractToolPayload(input.payload));
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "test.process.cleanup.evaluated",
				payload: testProcessCleanup,
			}),
		);
	}

	if (
		(primaryHookEnabled && hook.name === "harness.destructive.guard") ||
		destructiveGuardCompanionEnabled
	) {
		destructiveGuard = evaluateDestructiveGuard(extractToolPayload(input.payload));
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "destructive.guard.evaluated",
				payload: destructiveGuard,
			}),
		);
	}

	if (toolingEnforceEnabled) {
		toolingEnforce = evaluateToolingEnforce(extractToolPayload(input.payload));
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "tooling.enforce.evaluated",
				payload: toolingEnforce,
			}),
		);
	}

	if (primaryHookEnabled && hook.name === "harness.blast.check") {
		blastCheck = evaluateBlastCheck(extractToolPayload(input.payload));
		events.push(
			store.append({
				sessionId: input.sessionId,
				ts,
				type: "blast.check.evaluated",
				payload: blastCheck,
			}),
		);
	}

	const projectHooks = projectHooksEnabled ? runProjectHooks(payload) : undefined;
	if (projectHooks && projectHooks.executions.length > 0) {
		for (const execution of projectHooks.executions) {
			events.push(
				store.append({
					sessionId: input.sessionId,
					ts,
					type: "project.hook.executed",
					payload: execution,
				}),
			);
		}
	}

	return {
		dispatched: true,
		hook: dispatchedHook,
		events,
		sessionContext,
		costGuard,
		destructiveGuard,
		blastCheck,
		toolingEnforce,
		testProcessCleanup,
		projectHooks,
	};
}

export function isHookEnabled(hook: HookDefinition, config: PavedaConfig): boolean {
	if (!hook.profiles.includes(config.hookProfile)) {
		return false;
	}

	return !config.disabledHooks.some((selector) => matchesDisabledSelector(hook, selector));
}

export function resolveHookDefinition(input: DispatchHookEventInput): HookDefinition {
	const defaultHook =
		BUILT_IN_HOOKS.find(
			(hook) =>
				hook.lifecycle === input.lifecycle &&
				input.matcher !== undefined &&
				matchesHookMatcher(hook.matcher, input.matcher),
		) ?? BUILT_IN_HOOKS.find((hook) => hook.lifecycle === input.lifecycle && hook.matcher === "*");

	return {
		name: input.hookName ?? defaultHook?.name ?? `project.${input.lifecycle}`,
		lifecycle: input.lifecycle,
		matcher: input.matcher ?? defaultHook?.matcher ?? "*",
		profiles: defaultHook?.profiles ?? ["minimal", "standard", "strict"],
	};
}

function matchesDisabledSelector(hook: HookDefinition, selector: DisabledHookSelector): boolean {
	return (
		matchesPart(selector.lifecycle, hook.lifecycle) &&
		matchesPart(selector.matcher, hook.matcher) &&
		matchesPart(selector.name, hook.name)
	);
}

function matchesPart(selector: string, value: string): boolean {
	return selector === "*" || selector === value;
}

function matchesHookMatcher(hookMatcher: string, inputMatcher: string): boolean {
	return hookMatcher === "*" || hookMatcher.split("|").includes(inputMatcher);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findBuiltInHook(name: string): HookDefinition | undefined {
	return BUILT_IN_HOOKS.find((hook) => hook.name === name);
}

function resolveDispatchedHook(input: {
	hook: HookDefinition;
	primaryHookEnabled: boolean;
	destructiveGuardCompanionHook?: HookDefinition;
	destructiveGuardCompanionEnabled: boolean;
	toolingEnforceEnabled: boolean;
}): HookDefinition {
	if (input.primaryHookEnabled) {
		return input.hook;
	}

	if (input.destructiveGuardCompanionEnabled && input.destructiveGuardCompanionHook) {
		return input.destructiveGuardCompanionHook;
	}

	if (input.toolingEnforceEnabled) {
		return findBuiltInHook("harness.tooling.enforce") ?? input.hook;
	}

	return input.hook;
}

function extractAgentSpawnPayload(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) {
		return {};
	}

	const raw = isRecord(payload.raw) ? payload.raw : undefined;
	const toolResponse = raw && isRecord(raw.tool_response) ? raw.tool_response : undefined;

	return {
		toolUseId: raw?.tool_use_id,
		agentId: toolResponse?.agentId,
	};
}

function extractToolPayload(payload: unknown): {
	toolName?: string;
	toolInput?: unknown;
	cwd?: string;
} {
	if (!isRecord(payload)) {
		return {};
	}

	const raw = isRecord(payload.raw) ? payload.raw : undefined;

	return {
		toolName: typeof payload.tool === "string" ? payload.tool : undefined,
		toolInput: raw?.tool_input,
		cwd: extractPayloadCwd(payload),
	};
}

function extractPayloadCwd(payload: unknown): string | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}

	return typeof payload.cwd === "string" ? payload.cwd : undefined;
}

function shouldEvaluateCompanionHook(
	input: DispatchHookEventInput,
	config: PavedaConfig,
	hookName: string,
): boolean {
	if (input.lifecycle !== "tool.execute.before" || input.matcher !== "Bash") {
		return false;
	}

	const hook = findBuiltInHook(hookName);
	return hook ? isHookEnabled(hook, config) : false;
}

function resolveCompanionHook(
	input: DispatchHookEventInput,
	hookName: string,
): HookDefinition | undefined {
	if (
		hookName !== "harness.destructive.guard" ||
		input.lifecycle !== "tool.execute.before" ||
		input.hookName === hookName ||
		!input.matcher ||
		!isFileMutationMatcher(input.matcher)
	) {
		return undefined;
	}

	const hook = findBuiltInHook(hookName);
	return hook ? { ...hook, matcher: input.matcher } : undefined;
}

function isFileMutationMatcher(matcher: string): boolean {
	return matcher === "Edit" || matcher === "Write" || matcher === "apply_patch";
}

function resolveSessionConfig(
	store: EventStore,
	sessionId: string,
	candidate: PavedaConfig,
): SessionConfigResolution {
	const snapshot = store.replay(sessionId).find(isConfigSnapshotEvent)?.payload;

	return {
		config: snapshot ? cloneConfig(snapshot) : candidate,
		snapshotExists: Boolean(snapshot),
	};
}

function toConfigSnapshot(config: PavedaConfig): PavedaConfig {
	return cloneConfig(config);
}

function isConfigSnapshotEvent(
	event: EventRecord,
): event is EventRecord & { payload: PavedaConfig } {
	return event.type === "config.snapshot" && isPavedaConfig(event.payload);
}

function cloneConfig(config: PavedaConfig): PavedaConfig {
	return {
		...config,
		disabledHooks: config.disabledHooks.map((selector) => ({ ...selector })),
	};
}

function isPavedaConfig(value: unknown): value is PavedaConfig {
	if (!isRecord(value)) {
		return false;
	}

	return (
		isHookProfile(value.hookProfile) &&
		Array.isArray(value.disabledHooks) &&
		value.disabledHooks.every(isDisabledHookSelector) &&
		typeof value.projectHooks === "boolean" &&
		typeof value.sessionStartContext === "boolean" &&
		isPositiveInteger(value.sessionStartMaxChars) &&
		isPositiveInteger(value.costGuardMaxMinutes) &&
		isPositiveInteger(value.costGuardAgentWarningThreshold) &&
		isPositiveInteger(value.costGuardAgentCompactInterval)
	);
}

function isHookProfile(value: unknown): value is HookProfile {
	return value === "minimal" || value === "standard" || value === "strict";
}

function isDisabledHookSelector(value: unknown): value is DisabledHookSelector {
	return (
		isRecord(value) &&
		typeof value.lifecycle === "string" &&
		typeof value.matcher === "string" &&
		typeof value.name === "string"
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
