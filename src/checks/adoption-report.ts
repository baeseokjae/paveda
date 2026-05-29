import { type DoctorRecoveryAction, type DoctorResult, runDoctor } from "../doctor/index.js";
import {
	type HostSkillBundleTarget,
	parseHostSkillBundleTarget,
	resolveHostSkillRoot,
} from "../host-bundles/index.js";
import { type RouteSkillDecision, routeSkill } from "../router/index.js";
import {
	type SkillStatusEntry,
	findSkill,
	isSkillRouterEnabled,
	loadSkillStatus,
	loadSkills,
} from "../skill-loader/index.js";
import type { StoreScope } from "../store/index.js";
import { type RuntimeSmokeResult, runRuntimeSmoke } from "./runtime-smoke.js";

export interface AdoptionReportOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	targetRoot?: string;
	cliCommand?: string;
	runtimeSmoke?: boolean;
	dbPath?: string;
	sessionId?: string;
	storeScope?: StoreScope;
}

export type AdoptionReportCheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface AdoptionReportCheck {
	name: string;
	status: AdoptionReportCheckStatus;
	message: string;
	details?: unknown;
}

export interface AdoptionReportDoctorCheckSummary {
	name: string;
	message: string;
	path?: string;
	recovery?: DoctorRecoveryAction;
}

export interface AdoptionReportDoctorDetails {
	failures: AdoptionReportDoctorCheckSummary[];
}

export interface AdoptionReportRuntimeSmoke {
	name: "runtime-smoke";
	status: AdoptionReportCheckStatus;
	message: string;
	result?: RuntimeSmokeResult;
}

export interface AdoptionReportResult {
	ok: boolean;
	cwd: string;
	host: HostSkillBundleTarget;
	targetRoot?: string;
	doctor: DoctorResult;
	doSkill?: SkillStatusEntry;
	route: RouteSkillDecision;
	runtimeSmoke: AdoptionReportRuntimeSmoke;
	checks: AdoptionReportCheck[];
}

const ROUTE_AMBIGUITY_SMOKE_SCORE = 0.25;

export function runAdoptionReport(options: AdoptionReportOptions): AdoptionReportResult {
	const cwd = options.cwd ?? process.cwd();
	const host = parseHostSkillBundleTarget(options.host);
	const skillRoot = resolveHostSkillRoot(host, cwd, options.targetRoot);
	const doctor = runDoctor({
		cwd,
		host,
		targetRoot: options.targetRoot,
		cliCommand: options.cliCommand,
	});
	const skillOptions = {
		cwd,
		projectRoots: [skillRoot],
		userRoots: [],
		builtinRoots: [],
	};
	const skillStatus = loadSkillStatus(skillOptions);
	const doSkill = skillStatus.find((skill) => skill.name === "do");
	const loadedDoSkill = findSkill(loadSkills(skillOptions), "do");
	const route = routeSkill({
		skill: "do",
		routerEnabled: loadedDoSkill ? isSkillRouterEnabled(loadedDoSkill) : false,
		ambiguityRequired: loadedDoSkill?.frontmatter.ambiguityRequired,
		signals: { ambiguityScore: ROUTE_AMBIGUITY_SMOKE_SCORE },
	});
	const runtimeSmoke = options.runtimeSmoke
		? runRuntimeSmoke({
				cwd,
				dbPath: options.dbPath,
				sessionId: options.sessionId,
				storeScope: options.storeScope,
			})
		: undefined;
	const runtimeSmokeStatus = buildRuntimeSmokeStatus(runtimeSmoke);
	const checks = [
		buildDoctorCheck(doctor),
		buildDoSkillCheck(doSkill),
		buildDoRouterCheck(doSkill),
		buildRouteCheck(route),
		toRuntimeSmokeCheck(runtimeSmokeStatus),
	];

	return {
		ok: checks.every((check) => check.status !== "fail"),
		cwd,
		host,
		...(options.targetRoot ? { targetRoot: skillRoot } : {}),
		doctor,
		...(doSkill ? { doSkill } : {}),
		route,
		runtimeSmoke: runtimeSmokeStatus,
		checks,
	};
}

export function formatAdoptionReport(result: AdoptionReportResult): string {
	const lines = [
		"Paveda Adoption Report",
		`cwd: ${result.cwd}`,
		`host: ${result.host}`,
		...(result.targetRoot ? [`targetRoot: ${result.targetRoot}`] : []),
		`status: ${result.ok ? "ok" : "failed"}`,
		"",
	];

	for (const check of result.checks) {
		lines.push(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
		lines.push(...formatCheckDetails(check));
	}

	lines.push("");
	lines.push("Route:");
	lines.push(`  enabled: ${String(result.route.enabled)}`);
	lines.push(`  blocked: ${String(result.route.blocked)}`);
	lines.push(`  tier: ${result.route.tier}`);
	lines.push(`  reason: ${result.route.reason}`);

	if (result.runtimeSmoke.result) {
		lines.push("");
		lines.push("Runtime Smoke:");
		lines.push(`  session: ${result.runtimeSmoke.result.sessionId}`);
		lines.push(`  db: ${result.runtimeSmoke.result.dbPath}`);
		lines.push(`  events: ${result.runtimeSmoke.result.eventCount}`);
	}

	return lines.join("\n");
}

function buildDoctorCheck(doctor: DoctorResult): AdoptionReportCheck {
	const failures = doctor.checks
		.filter((check) => check.status === "fail")
		.map(toDoctorCheckSummary);

	if (doctor.ok) {
		return {
			name: "doctor",
			status: "pass",
			message: "Host bundle readiness checks pass.",
		};
	}

	return {
		name: "doctor",
		status: "fail",
		message:
			failures.length === 0
				? "Host bundle readiness checks have failures."
				: `Host bundle readiness checks failed: ${summarizeNames(
						failures.map((failure) => failure.name),
					)}.`,
		details: { failures },
	};
}

function buildDoSkillCheck(doSkill: SkillStatusEntry | undefined): AdoptionReportCheck {
	if (!doSkill) {
		return {
			name: "do-skill",
			status: "fail",
			message: "Host /do skill is missing.",
		};
	}

	return {
		name: "do-skill",
		status: doSkill.selected.scope === "project" ? "pass" : "fail",
		message:
			doSkill.selected.scope === "project"
				? "Host /do skill resolves from project scope."
				: `Host /do skill resolves from ${doSkill.selected.scope} scope.`,
	};
}

function buildDoRouterCheck(doSkill: SkillStatusEntry | undefined): AdoptionReportCheck {
	return {
		name: "do-router",
		status: doSkill?.routerEnabled ? "pass" : "fail",
		message: doSkill?.routerEnabled
			? "/do router metadata is enabled."
			: "/do router metadata is missing or shadowed.",
	};
}

function buildRouteCheck(route: RouteSkillDecision): AdoptionReportCheck {
	const pass = route.enabled && route.blocked && route.reason === "blocked:ambiguity";
	return {
		name: "route-do",
		status: pass ? "pass" : "fail",
		message: pass
			? "/do ambiguity gate blocks the smoke score."
			: `/do route smoke failed with reason ${route.reason}.`,
	};
}

function buildRuntimeSmokeStatus(
	result: RuntimeSmokeResult | undefined,
): AdoptionReportRuntimeSmoke {
	if (!result) {
		return {
			name: "runtime-smoke",
			status: "skipped",
			message: "Runtime write smoke was not run. Use --runtime-smoke to verify EventStore writes.",
		};
	}

	return {
		name: "runtime-smoke",
		status: result.ok ? "pass" : "fail",
		message: result.ok
			? "Runtime smoke verified EventStore write/replay/status."
			: "Runtime smoke failed.",
		result,
	};
}

function toRuntimeSmokeCheck(result: AdoptionReportRuntimeSmoke): AdoptionReportCheck {
	return {
		name: result.name,
		status: result.status,
		message: result.message,
	};
}

function toDoctorCheckSummary(
	check: DoctorResult["checks"][number],
): AdoptionReportDoctorCheckSummary {
	return {
		name: check.name,
		message: check.message,
		...(check.path ? { path: check.path } : {}),
		...(check.recovery ? { recovery: check.recovery } : {}),
	};
}

function summarizeNames(names: string[]): string {
	const visible = names.slice(0, 4);
	const suffix = names.length > visible.length ? `, and ${names.length - visible.length} more` : "";
	return `${visible.join(", ")}${suffix}`;
}

function formatCheckDetails(check: AdoptionReportCheck): string[] {
	const doctorDetails = parseDoctorDetails(check.details);
	if (!doctorDetails || doctorDetails.failures.length === 0) {
		return [];
	}

	return doctorDetails.failures.flatMap((failure) => [
		`  - ${failure.name}: ${failure.message}`,
		...(failure.path ? [`    path: ${failure.path}`] : []),
		...(failure.recovery ? [`    recovery: ${failure.recovery.command}`] : []),
	]);
}

function parseDoctorDetails(details: unknown): AdoptionReportDoctorDetails | undefined {
	if (!isRecord(details) || !Array.isArray(details.failures)) {
		return undefined;
	}

	const failures = details.failures.filter(isDoctorCheckSummary);
	if (failures.length !== details.failures.length) {
		return undefined;
	}

	return { failures };
}

function isDoctorCheckSummary(value: unknown): value is AdoptionReportDoctorCheckSummary {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		typeof value.message === "string" &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.recovery === undefined || isRecoveryAction(value.recovery))
	);
}

function isRecoveryAction(value: unknown): value is DoctorRecoveryAction {
	return (
		isRecord(value) && typeof value.command === "string" && typeof value.description === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
