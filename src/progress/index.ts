import {
	type RunSpecBinding,
	type RunStatusResult,
	type StagnationState,
	readRunSpecBinding,
	summarizeRun,
	verifyRun,
} from "../execution/index.js";
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
	specBinding: ProgressSpecBinding | null;
	stagnation: ProgressStagnation | null;
	currentPhase: ProgressPhase | null;
	latestHostEvent: ProgressHostEvent | null;
	stages: ProgressVerificationStage[];
	gates: ProgressGate[];
	evidenceGaps: ProgressEvidenceGap[];
	nextCommands: string[];
}

export interface ProgressSpecBinding {
	bindingId: string;
	sourceType: RunSpecBinding["sourceType"];
	sourcePath: string | null;
	specSha256: string | null;
	acceptanceSha256: string;
	ambiguityScore: number | null;
	contractVersion: string | null;
	createdAt: number;
}

export interface ProgressStagnation {
	pattern: StagnationState["pattern"];
	phaseId: string;
	iterations: number[];
	severity: StagnationState["severity"];
	message: string;
	recovery: string;
	nextCommand: string;
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

export interface ProgressVerificationStage {
	stage: string;
	result: string;
	required: boolean;
	triggeredBy: string[];
	score: number | null;
	nextCommand: string | null;
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
		`- Spec binding: ${
			progress.specBinding
				? `${progress.specBinding.bindingId} (${progress.specBinding.sourceType})`
				: "none"
		}`,
		`- Stagnation: ${
			progress.stagnation
				? `${progress.stagnation.pattern} (${progress.stagnation.severity})`
				: "none"
		}`,
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
		"## Stages",
		...progress.stages.map(
			(stage) =>
				`- ${stage.stage}: ${stage.result}${stage.required ? " (required)" : ""}${
					stage.nextCommand ? `\n  Next: \`${stage.nextCommand}\`` : ""
				}`,
		),
		"",
		"## Evidence Gaps",
		...(progress.evidenceGaps.length > 0
			? progress.evidenceGaps.map(
					(gap) => `- ${gap.gateId}: ${gap.message}\n  Next: \`${gap.nextCommand}\``,
				)
			: ["- none"]),
		"",
		"## Recovery",
		...(progress.stagnation
			? [
					`- ${progress.stagnation.message}`,
					`- Action: ${progress.stagnation.recovery}`,
					`- Next: \`${progress.stagnation.nextCommand}\``,
				]
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
		`Spec binding: ${
			progress.specBinding
				? `${progress.specBinding.bindingId} (${progress.specBinding.sourceType})`
				: "none"
		}`,
		`Stagnation: ${
			progress.stagnation
				? `${progress.stagnation.pattern} (${progress.stagnation.severity})`
				: "none"
		}`,
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
		"## Stages",
		...progress.stages.map(
			(stage) =>
				`- ${stage.stage}: ${stage.result}${stage.required ? " (required)" : ""}${
					stage.nextCommand ? `\n  Next: \`${stage.nextCommand}\`` : ""
				}`,
		),
		"",
		"## Recovery",
		...(progress.stagnation
			? [
					`- ${progress.stagnation.message}`,
					`- Action: ${progress.stagnation.recovery}`,
					`- Next: \`${progress.stagnation.nextCommand}\``,
				]
			: ["- none"]),
		"",
		"## Next Commands",
		...progress.nextCommands.map((command) => `- \`${command}\``),
		"",
	].join("\n");
}

export function formatRunReportMarkdown(status: RunStatusWithProgress): string {
	const progress = status.progress;
	return [
		`# Paveda Run Report ${progress.runId}`,
		"",
		"## Run Summary",
		`- Status: ${progress.status}`,
		`- Host: ${progress.host ?? "unknown"}`,
		`- Profile: ${progress.profile}`,
		`- Task type: ${progress.taskType}`,
		"",
		"## Spec Binding",
		progress.specBinding
			? `- ${progress.specBinding.bindingId} (${progress.specBinding.sourceType})`
			: "- none",
		"",
		"## Phase Timeline",
		...(status.phaseEvents.length > 0
			? status.phaseEvents.map((event) => `- ${event.phaseId}: ${event.eventType}`)
			: ["- none"]),
		"",
		"## Verification Stages",
		...progress.stages.map((stage) => `- ${stage.stage}: ${stage.result}`),
		"",
		"## Evidence Table",
		...(status.evidence.length > 0
			? status.evidence.map((item) => `- ${item.kind}: ${item.result} (${item.evidenceId})`)
			: ["- none"]),
		"",
		"## Artifact Table",
		...(status.artifacts.length > 0
			? status.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.relativePath}`)
			: ["- none"]),
		"",
		"## Policy Decisions",
		...(status.policyViolations.length > 0
			? status.policyViolations.map((violation) => `- ${violation.policyId}: ${violation.message}`)
			: ["- none"]),
		"",
		"## Stagnation State",
		progress.stagnation ? `- ${progress.stagnation.message}` : "- none",
		"",
		"## Learning Candidates",
		"- none",
		"",
		"## Next Command",
		...progress.nextCommands.map((command) => `- \`${command}\``),
		"",
	].join("\n");
}

export function formatRunReportHtml(
	progress: RunProgressSummary,
	generatedAt = Date.now(),
	status?: RunStatusWithProgress,
): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>Paveda Run ${escapeHtml(progress.runId)}</title>`,
		"<style>",
		"body{font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:32px;line-height:1.45;color:#1f2937;background:#fff}",
		"main{max-width:1040px;margin:0 auto}",
		"h1{font-size:28px;margin:0 0 8px}",
		"h2{font-size:18px;margin-top:28px;border-bottom:1px solid #d1d5db;padding-bottom:6px}",
		"table{border-collapse:collapse;width:100%;margin-top:8px}",
		"th,td{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}",
		"th{background:#f3f4f6}",
		"code{background:#f3f4f6;padding:2px 4px;border-radius:4px}",
		".meta{color:#4b5563}",
		".block{color:#b91c1c;font-weight:600}",
		".pass{color:#047857;font-weight:600}",
		".warn{color:#b45309;font-weight:600}",
		"</style>",
		"</head>",
		"<body><main>",
		`<h1>Paveda Run ${escapeHtml(progress.runId)}</h1>`,
		`<p class="meta">Generated ${escapeHtml(new Date(generatedAt).toISOString())}</p>`,
		"<h2>Summary</h2>",
		"<table><tbody>",
		reportRow("Status", progress.status),
		reportRow("Host", progress.host ?? "unknown"),
		reportRow("Profile", progress.profile),
		reportRow("Task type", progress.taskType),
		reportRow(
			"Spec binding",
			progress.specBinding
				? `${progress.specBinding.bindingId} (${progress.specBinding.sourceType})`
				: "none",
		),
		reportRow(
			"Stagnation",
			progress.stagnation
				? `${progress.stagnation.pattern} (${progress.stagnation.severity})`
				: "none",
		),
		"</tbody></table>",
		"<h2>Stages</h2>",
		reportTable(
			["Stage", "Result", "Required", "Triggered By", "Next"],
			progress.stages.map((stage) => [
				stage.stage,
				stage.result,
				stage.required ? "yes" : "no",
				stage.triggeredBy.join(", "),
				stage.nextCommand ?? "",
			]),
		),
		"<h2>Gates</h2>",
		reportTable(
			["Gate", "Phase", "Evidence", "Status", "Message"],
			progress.gates.map((gate) => [
				gate.id,
				gate.phase,
				gate.evidenceKind,
				gate.status,
				gate.message,
			]),
		),
		"<h2>Evidence Gaps</h2>",
		reportTable(
			["Gate", "Message", "Next"],
			progress.evidenceGaps.map((gap) => [gap.gateId, gap.message, gap.nextCommand]),
		),
		"<h2>Recovery</h2>",
		progress.stagnation
			? `<p class="warn">${escapeHtml(progress.stagnation.message)}</p><p>${escapeHtml(
					progress.stagnation.recovery,
				)}</p><p><code>${escapeHtml(progress.stagnation.nextCommand)}</code></p>`
			: "<p>none</p>",
		"<h2>Phase Timeline</h2>",
		status
			? reportTable(
					["Phase", "Event", "Status"],
					status.phaseEvents.map((event) => [event.phaseId, event.eventType, event.status ?? ""]),
				)
			: "<p>none</p>",
		"<h2>Evidence Table</h2>",
		status
			? reportTable(
					["ID", "Kind", "Result", "Rationale"],
					status.evidence.map((item) => [
						item.evidenceId,
						item.kind,
						item.result,
						item.rationale ?? "",
					]),
				)
			: "<p>none</p>",
		"<h2>Artifact Table</h2>",
		status
			? reportTable(
					["Kind", "Path", "SHA-256", "Redaction"],
					status.artifacts.map((artifact) => [
						artifact.kind,
						artifact.relativePath,
						artifact.sha256,
						artifact.redactionStatus,
					]),
				)
			: "<p>none</p>",
		"<h2>Policy Decisions</h2>",
		status
			? reportTable(
					["Policy", "Severity", "Blocked", "Message"],
					status.policyViolations.map((violation) => [
						violation.policyId,
						violation.severity,
						violation.blocked ? "yes" : "no",
						violation.message,
					]),
				)
			: "<p>none</p>",
		"<h2>Learning Candidates</h2>",
		"<p>none</p>",
		"<h2>Next Commands</h2>",
		`<ul>${progress.nextCommands
			.map((command) => `<li><code>${escapeHtml(command)}</code></li>`)
			.join("")}</ul>`,
		"</main></body></html>",
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
		specBinding: summarizeSpecBinding(readRunSpecBinding(status.run)),
		stagnation: summarizeStagnation(status.stagnation),
		currentPhase: latestPhase(status.phaseEvents),
		latestHostEvent: latestHost(status.hostEvents),
		stages: verification.stages.map((stage) => ({
			stage: stage.stage,
			result: stage.result,
			required: stage.required,
			triggeredBy: stage.triggeredBy,
			score: stage.score ?? null,
			nextCommand: stage.nextCommand ?? null,
		})),
		gates,
		evidenceGaps,
		nextCommands: nextCommands(status.run, evidenceGaps, status.stagnation),
	};
}

function summarizeStagnation(stagnation: StagnationState | null): ProgressStagnation | null {
	if (!stagnation) {
		return null;
	}
	return {
		pattern: stagnation.pattern,
		phaseId: stagnation.phaseId,
		iterations: stagnation.iterations,
		severity: stagnation.severity,
		message: stagnation.message,
		recovery: stagnation.recovery,
		nextCommand: stagnation.nextCommand,
	};
}

function summarizeSpecBinding(binding: RunSpecBinding | null): ProgressSpecBinding | null {
	if (!binding) {
		return null;
	}
	return {
		bindingId: binding.bindingId,
		sourceType: binding.sourceType,
		sourcePath: binding.sourcePath ?? null,
		specSha256: binding.specSha256 ?? null,
		acceptanceSha256: binding.acceptanceSha256,
		ambiguityScore: binding.ambiguityScore ?? null,
		contractVersion: binding.contractVersion ?? null,
		createdAt: binding.createdAt,
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

function nextCommands(
	run: RunRecord,
	gaps: readonly ProgressEvidenceGap[],
	stagnation: StagnationState | null,
): string[] {
	if (stagnation) {
		return [stagnation.nextCommand];
	}
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

function reportRow(label: string, value: string): string {
	return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function reportTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	if (rows.length === 0) {
		return "<p>none</p>";
	}
	return [
		"<table>",
		`<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>`,
		`<tbody>${rows
			.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
			.join("")}</tbody>`,
		"</table>",
	].join("");
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
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
