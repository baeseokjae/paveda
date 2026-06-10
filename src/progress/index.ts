import { type RunStatusResult, summarizeRun, verifyRun } from "../execution/index.js";
import type { HostEventRecord, PhaseEventRecord, RunRecord, StoreScope } from "../store/index.js";

export interface RunProgressOptions {
	cwd?: string;
	runId: string;
	dbPath?: string;
	storeScope?: StoreScope;
}

export interface RunProgressSummary {
	schemaVersion: 1;
	runId: string;
	status: RunRecord["status"];
	host: string | null;
	profile: RunRecord["profile"];
	taskType: string;
	currentPhase: ProgressPhase | null;
	latestHostEvent: ProgressHostEvent | null;
	gates: ProgressGate[];
	evidenceGaps: ProgressEvidenceGap[];
	nextCommands: string[];
}

export interface ProgressPhase {
	phaseId: string;
	status: string;
	eventType: string;
	ts: number;
}

export interface ProgressHostEvent {
	host: string;
	eventType: string;
	normalizedStatus: string | null;
	ts: number;
}

export interface ProgressGate {
	id: string;
	phase: string;
	evidenceKind: string;
	status: string;
	message: string;
}

export interface ProgressEvidenceGap {
	gateId: string;
	phase: string;
	evidenceKind: string;
	message: string;
	nextCommand: string;
}

export interface RunStatusWithProgress extends RunStatusResult {
	progress: RunProgressSummary;
}

export function summarizeRunWithProgress(options: RunProgressOptions): RunStatusWithProgress {
	const status = summarizeRun(options);
	return {
		...status,
		progress: buildProgressSummary(status, {
			cwd: options.cwd,
			dbPath: options.dbPath,
			storeScope: options.storeScope,
		}),
	};
}

export function summarizeProgress(options: RunProgressOptions): RunProgressSummary {
	return summarizeRunWithProgress(options).progress;
}

export function formatProgressMarkdown(progress: RunProgressSummary): string {
	const lines = [
		`# Paveda Run ${progress.runId}`,
		"",
		`- Status: ${progress.status}`,
		`- Host: ${progress.host ?? "unknown"}`,
		`- Profile: ${progress.profile}`,
		`- Task type: ${progress.taskType}`,
		`- Current phase: ${
			progress.currentPhase
				? `${progress.currentPhase.phaseId} (${progress.currentPhase.status})`
				: "none"
		}`,
		`- Latest host event: ${
			progress.latestHostEvent
				? `${progress.latestHostEvent.host}:${progress.latestHostEvent.eventType}`
				: "none"
		}`,
		"",
		"## Gates",
		...progress.gates.map((gate) => `- ${gate.id}: ${gate.status} - ${gate.message}`),
		"",
		"## Evidence Gaps",
		...(progress.evidenceGaps.length > 0
			? progress.evidenceGaps.map(
					(gap) => `- ${gap.gateId}: ${gap.message}\n  Next: \`${gap.nextCommand}\``,
				)
			: ["- none"]),
		"",
		"## Next Commands",
		...progress.nextCommands.map((command) => `- \`${command}\``),
	];
	return `${lines.join("\n")}\n`;
}

export function formatHandoffMarkdown(progress: RunProgressSummary): string {
	return [
		`# Paveda Handoff ${progress.runId}`,
		"",
		`Status: ${progress.status}`,
		`Host: ${progress.host ?? "unknown"}`,
		`Profile: ${progress.profile}`,
		"",
		"## Current State",
		`Phase: ${
			progress.currentPhase
				? `${progress.currentPhase.phaseId} (${progress.currentPhase.status})`
				: "none"
		}`,
		`Latest host event: ${
			progress.latestHostEvent
				? `${progress.latestHostEvent.host}:${progress.latestHostEvent.eventType}`
				: "none"
		}`,
		"",
		"## Blocked Gates",
		...(progress.evidenceGaps.length > 0
			? progress.evidenceGaps.map((gap) => `- ${gap.gateId}: ${gap.message}`)
			: ["- none"]),
		"",
		"## Next Commands",
		...progress.nextCommands.map((command) => `- \`${command}\``),
		"",
	].join("\n");
}

function buildProgressSummary(
	status: RunStatusResult,
	options: {
		cwd?: string;
		dbPath?: string;
		storeScope?: StoreScope;
	},
): RunProgressSummary {
	const verification = verifyRun({
		cwd: options.cwd,
		runId: status.run.runId,
		profile: status.run.profile,
		dbPath: options.dbPath,
		storeScope: options.storeScope,
	});
	const gates = verification.gates.map((gate) => ({
		id: gate.id,
		phase: gate.phase,
		evidenceKind: gate.evidenceKind,
		status: gate.status,
		message: gate.message,
	}));
	const evidenceGaps = verification.gates
		.filter((gate) => gate.status === "block")
		.map((gate) => ({
			gateId: gate.id,
			phase: gate.phase,
			evidenceKind: gate.evidenceKind,
			message: gate.message,
			nextCommand: evidenceCommand(status.run.runId, gate.phase, gate.evidenceKind),
		}));
	return {
		schemaVersion: 1,
		runId: status.run.runId,
		status: status.run.status,
		host: status.run.host,
		profile: status.run.profile,
		taskType: readTaskType(status.run),
		currentPhase: latestPhase(status.phaseEvents),
		latestHostEvent: latestHost(status.hostEvents),
		gates,
		evidenceGaps,
		nextCommands: nextCommands(status.run, evidenceGaps),
	};
}

function latestPhase(events: readonly PhaseEventRecord[]): ProgressPhase | null {
	const event = latestByTimestamp(events);
	return event
		? {
				phaseId: event.phaseId,
				status: event.status ?? "pending",
				eventType: event.eventType,
				ts: event.ts,
			}
		: null;
}

function latestHost(events: readonly HostEventRecord[]): ProgressHostEvent | null {
	const event = latestByTimestamp(events);
	return event
		? {
				host: event.host,
				eventType: event.eventType,
				normalizedStatus: event.normalizedStatus,
				ts: event.ts,
			}
		: null;
}

function latestByTimestamp<T extends { ts: number; id: number }>(events: readonly T[]): T | null {
	return [...events].sort((left, right) => right.ts - left.ts || right.id - left.id)[0] ?? null;
}

function nextCommands(run: RunRecord, gaps: readonly ProgressEvidenceGap[]): string[] {
	if (gaps.length > 0) {
		return gaps.map((gap) => gap.nextCommand);
	}
	if (run.status === "completed") {
		return [`paveda status --run ${run.runId} --format markdown`];
	}
	return [`paveda verify --run ${run.runId} --profile ${run.profile} --write`];
}

function evidenceCommand(runId: string, phase: string, evidenceKind: string): string {
	return [
		"paveda evidence add",
		`--run ${runId}`,
		`--phase ${phase}`,
		`--kind ${evidenceKind}`,
		"--result pass",
		'--rationale "record passing evidence"',
	].join(" ");
}

function readTaskType(run: RunRecord): string {
	const context = run.context;
	if (typeof context === "object" && context !== null && !Array.isArray(context)) {
		const taskType = (context as { taskType?: unknown }).taskType;
		if (typeof taskType === "string" && taskType.length > 0) {
			return taskType;
		}
	}
	return "command";
}
