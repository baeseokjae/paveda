import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ConformanceResult } from "../conformance/index.js";
import type { VerifyRunResult } from "../execution/index.js";
import { assertWritePathIsSafe, writeTextFileSafely } from "../fs-safety.js";

export type ReportNodeStatus = "pass" | "fail" | "block" | "not_applicable" | "not_required";

export interface ReportNode {
	suite: string;
	case: string;
	status: ReportNodeStatus;
	durationMs: number;
	message: string;
	details?: unknown;
	artifactRefs: string[];
}

export interface NormalizedReport {
	schemaVersion: 1;
	generatedAt: string;
	ok: boolean;
	nodes: ReportNode[];
}

export interface ReportWriteOptions {
	reportJson?: string | null;
	reportJunit?: string | null;
	reportDir?: string | null;
	prefix: string;
	now?: number;
}

export interface ReportWriteResult {
	jsonPath: string | null;
	junitPath: string | null;
}

export function verificationReport(result: VerifyRunResult, now = Date.now()): NormalizedReport {
	const suite = `verify:${result.runId}`;
	const gateNodes: ReportNode[] = result.gates.map((gate) => ({
		suite,
		case: `gate:${gate.id}`,
		status: gate.status === "block" ? "block" : gate.status,
		durationMs: 0,
		message: gate.message,
		details: gate,
		artifactRefs: [],
	}));
	const ladderNodes: ReportNode[] = result.ladder.map((step) => ({
		suite,
		case: `ladder:${step.evidenceKind}`,
		status: step.status,
		durationMs: 0,
		message: step.message,
		details: step,
		artifactRefs: step.evidenceIds.map((id) => `evidence:${id}`),
	}));
	return {
		schemaVersion: 1,
		generatedAt: new Date(now).toISOString(),
		ok: result.ok,
		nodes: [...gateNodes, ...ladderNodes],
	};
}

export function conformanceReport(result: ConformanceResult, now = Date.now()): NormalizedReport {
	return {
		schemaVersion: 1,
		generatedAt: new Date(now).toISOString(),
		ok: result.ok,
		nodes: result.fixtures.map((fixture) => ({
			suite: `conformance:${result.host}`,
			case: fixture.id,
			status: fixture.status === "pass" ? "pass" : "fail",
			durationMs: 0,
			message: fixture.message,
			details: fixture.details ?? null,
			artifactRefs: [],
		})),
	};
}

export function writeReports(
	report: NormalizedReport,
	options: ReportWriteOptions,
): ReportWriteResult {
	const jsonPath =
		options.reportJson ?? defaultReportPath(options.reportDir, options.prefix, "json");
	const junitPath =
		options.reportJunit ?? defaultReportPath(options.reportDir, options.prefix, "junit.xml");
	if (jsonPath) {
		writeReportFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
	}
	if (junitPath) {
		writeReportFile(junitPath, renderJUnit(report));
	}
	return {
		jsonPath: jsonPath ? resolve(jsonPath) : null,
		junitPath: junitPath ? resolve(junitPath) : null,
	};
}

export function renderJUnit(report: NormalizedReport): string {
	const suites = groupBySuite(report.nodes);
	const tests = report.nodes.length;
	const failures = report.nodes.filter(isFailureStatus).length;
	const skipped = report.nodes.filter(isSkippedStatus).length;
	const body = [...suites.entries()].map(([suite, nodes]) => renderSuite(suite, nodes)).join("");
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites tests="${tests}" failures="${failures}" skipped="${skipped}">`,
		body,
		"</testsuites>",
		"",
	].join("\n");
}

function renderSuite(suite: string, nodes: readonly ReportNode[]): string {
	const failures = nodes.filter(isFailureStatus).length;
	const skipped = nodes.filter(isSkippedStatus).length;
	const cases = nodes.map((node) => renderCase(node)).join("");
	return [
		`<testsuite name="${xml(suite)}" tests="${nodes.length}" failures="${failures}" skipped="${skipped}">`,
		cases,
		"</testsuite>",
	].join("\n");
}

function renderCase(node: ReportNode): string {
	const properties = [
		`<property name="paveda.status" value="${xml(node.status)}"/>`,
		...node.artifactRefs.map((ref) => `<property name="paveda.artifact" value="${xml(ref)}"/>`),
	].join("");
	const failure = isFailureStatus(node)
		? `<failure message="${xml(node.message)}" type="${xml(node.status)}">${xml(
				JSON.stringify(node.details ?? node.message),
			)}</failure>`
		: "";
	const skipped = isSkippedStatus(node) ? `<skipped message="${xml(node.message)}"/>` : "";
	return [
		`<testcase classname="${xml(node.suite)}" name="${xml(node.case)}" time="${(
			node.durationMs / 1000
		).toFixed(3)}">`,
		`<properties>${properties}</properties>`,
		failure,
		skipped,
		"</testcase>",
	].join("\n");
}

function writeReportFile(path: string, content: string): void {
	assertWritePathIsSafe(path);
	mkdirSync(dirname(path), { recursive: true });
	writeTextFileSafely(path, content);
}

function defaultReportPath(
	reportDir: string | null | undefined,
	prefix: string,
	extension: string,
): string | null {
	return reportDir ? join(reportDir, `${prefix}.${extension}`) : null;
}

function groupBySuite(nodes: readonly ReportNode[]): Map<string, ReportNode[]> {
	const suites = new Map<string, ReportNode[]>();
	for (const node of nodes) {
		suites.set(node.suite, [...(suites.get(node.suite) ?? []), node]);
	}
	return suites;
}

function isFailureStatus(node: ReportNode): boolean {
	return node.status === "fail" || node.status === "block";
}

function isSkippedStatus(node: ReportNode): boolean {
	return node.status === "not_applicable" || node.status === "not_required";
}

function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
