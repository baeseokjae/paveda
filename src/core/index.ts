export type HookProfile = "minimal" | "standard" | "strict";

export type RouterTier = "frugal" | "standard" | "frontier";

export type LifecycleEvent =
	| "session.created"
	| "tool.execute.before"
	| "tool.execute.after"
	| "session.completed"
	| "hook.fired"
	| "skill.invoked"
	| "router.escalate"
	| "router.downgrade";

export interface PavedaConfig {
	hookProfile: HookProfile;
	disabledHooks: DisabledHookSelector[];
	projectHooks: boolean;
	sessionStartContext: boolean;
	sessionStartMaxChars: number;
	costGuardMaxMinutes: number;
	costGuardAgentWarningThreshold: number;
	costGuardAgentCompactInterval: number;
}

export interface DisabledHookSelector {
	lifecycle: string;
	matcher: string;
	name: string;
}

export const DEFAULT_HOOK_PROFILE: HookProfile = "standard";
export const DEFAULT_SESSION_START_MAX_CHARS = 8000;
export const DEFAULT_COST_GUARD_MAX_MINUTES = 120;
export const DEFAULT_COST_GUARD_AGENT_WARNING_THRESHOLD = 5;
export const DEFAULT_COST_GUARD_AGENT_COMPACT_INTERVAL = 3;
export const STRICT_COST_GUARD_MAX_MINUTES = 60;
export const STRICT_COST_GUARD_AGENT_WARNING_THRESHOLD = 3;
export const STRICT_COST_GUARD_AGENT_COMPACT_INTERVAL = 2;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PavedaConfig {
	const hookProfile = parseHookProfile(env.PAVEDA_HOOK_PROFILE);
	const costGuardDefaults = costGuardDefaultsForProfile(hookProfile);

	return {
		hookProfile,
		disabledHooks: parseDisabledHooks(env.PAVEDA_DISABLED_HOOKS),
		projectHooks: parseProjectHooks(env.PAVEDA_PROJECT_HOOKS),
		sessionStartContext: parseSessionStartContext(env.PAVEDA_SESSION_START_CONTEXT),
		sessionStartMaxChars: parsePositiveInteger(
			env.PAVEDA_SESSION_START_MAX_CHARS,
			DEFAULT_SESSION_START_MAX_CHARS,
			"PAVEDA_SESSION_START_MAX_CHARS",
		),
		costGuardMaxMinutes: parsePositiveInteger(
			env.PAVEDA_COST_GUARD_MAX_MINUTES,
			costGuardDefaults.maxMinutes,
			"PAVEDA_COST_GUARD_MAX_MINUTES",
		),
		costGuardAgentWarningThreshold: parsePositiveInteger(
			env.PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD,
			costGuardDefaults.agentWarningThreshold,
			"PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD",
		),
		costGuardAgentCompactInterval: parsePositiveInteger(
			env.PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL,
			costGuardDefaults.agentCompactInterval,
			"PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL",
		),
	};
}

function costGuardDefaultsForProfile(profile: HookProfile): {
	maxMinutes: number;
	agentWarningThreshold: number;
	agentCompactInterval: number;
} {
	if (profile === "strict") {
		return {
			maxMinutes: STRICT_COST_GUARD_MAX_MINUTES,
			agentWarningThreshold: STRICT_COST_GUARD_AGENT_WARNING_THRESHOLD,
			agentCompactInterval: STRICT_COST_GUARD_AGENT_COMPACT_INTERVAL,
		};
	}

	return {
		maxMinutes: DEFAULT_COST_GUARD_MAX_MINUTES,
		agentWarningThreshold: DEFAULT_COST_GUARD_AGENT_WARNING_THRESHOLD,
		agentCompactInterval: DEFAULT_COST_GUARD_AGENT_COMPACT_INTERVAL,
	};
}

export function parseHookProfile(value: string | undefined): HookProfile {
	if (!value) {
		return DEFAULT_HOOK_PROFILE;
	}

	if (value === "minimal" || value === "standard" || value === "strict") {
		return value;
	}

	throw new Error(`Invalid PAVEDA_HOOK_PROFILE: ${value}`);
}

export function parseDisabledHooks(value: string | undefined): DisabledHookSelector[] {
	if (!value) {
		return [];
	}

	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map(parseDisabledHookSelector);
}

export function parseDisabledHookSelector(value: string): DisabledHookSelector {
	const parts = value.split(":");
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
		throw new Error(`Invalid disabled hook selector: ${value}`);
	}

	const [lifecycle, matcher, name] = parts as [string, string, string];
	return { lifecycle, matcher, name };
}

export function parseProjectHooks(value: string | undefined): boolean {
	if (!value) {
		return false;
	}

	if (value === "on" || value === "true" || value === "1") {
		return true;
	}

	if (value === "off" || value === "false" || value === "0") {
		return false;
	}

	throw new Error(`Invalid PAVEDA_PROJECT_HOOKS: ${value}`);
}

export function parseSessionStartContext(value: string | undefined): boolean {
	if (!value) {
		return true;
	}

	if (value === "on" || value === "true" || value === "1") {
		return true;
	}

	if (value === "off" || value === "false" || value === "0") {
		return false;
	}

	throw new Error(`Invalid PAVEDA_SESSION_START_CONTEXT: ${value}`);
}

function parsePositiveInteger(
	value: string | undefined,
	defaultValue: number,
	name: string,
): number {
	if (!value) {
		return defaultValue;
	}

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Invalid ${name}: ${value}`);
	}

	return parsed;
}
