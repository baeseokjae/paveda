import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertWritePathIsSafe, writeTextFileSafely } from "../fs-safety.js";
import type {
	EventStore,
	InstinctScope,
	LearningPatternRecord,
	LearningState,
} from "../store/index.js";

export const LEARNING_PROMOTION_CONFIDENCE_THRESHOLD = 0.9;

export interface ProposeLearningPatternOptions {
	store: EventStore;
	runId: string;
	scope?: InstinctScope | "shared";
	state?: LearningState;
	pattern: string;
	confidence: number;
	evidenceId?: number;
	metadata?: unknown;
	now?: number;
}

export interface PromoteLearningPatternOptions {
	store: EventStore;
	cwd?: string;
	id: number;
	approvedBy: string;
	write?: boolean;
	now?: number;
}

export interface RetireLearningPatternOptions {
	store: EventStore;
	cwd?: string;
	id: number;
	reason: string;
	write?: boolean;
	now?: number;
}

export interface ExplainLearningPatternOptions {
	store: EventStore;
	cwd?: string;
	id: number;
}

export interface LearningPromotionEligibility {
	eligible: boolean;
	failures: string[];
	requirements: string[];
}

export interface PromoteLearningPatternResult {
	pattern: LearningPatternRecord;
	decisionId: number;
	eligibility: LearningPromotionEligibility;
	knowledgeFile: LearningKnowledgeFileResult;
}

export interface RetireLearningPatternResult {
	pattern: LearningPatternRecord;
	decisionId: number;
	knowledgeFile: LearningKnowledgeFileResult;
}

export interface ExplainLearningPatternResult {
	pattern: LearningPatternRecord;
	eligibility: LearningPromotionEligibility;
	knowledgeFilePath: string;
	policy: {
		promotionConfidenceThreshold: number;
		cannotRelaxGates: true;
		projectScopeOnlyInMvp: true;
	};
}

export interface LearningKnowledgeFileResult {
	path: string;
	status: "written" | "not_requested";
	patternCount?: number;
}

interface PromotedLearningFile {
	schemaVersion: "1.0.0";
	generatedBy: "paveda learning promote";
	patterns: PromotedLearningFilePattern[];
}

interface PromotedLearningFilePattern {
	id: number;
	runId: string;
	scope: "project";
	pattern: string;
	confidence: number;
	evidenceId: number;
	promotedAt: number;
	approvedBy: string;
	metadata: unknown;
}

export function proposeLearningPattern(
	options: ProposeLearningPatternOptions,
): LearningPatternRecord {
	const state = options.state ?? (options.evidenceId ? "candidate" : "observed");
	if (state === "promoted" || state === "retired") {
		throw new Error("learning propose cannot create promoted or retired patterns");
	}
	if ((state === "candidate" || state === "validated") && !options.evidenceId) {
		throw new Error(`${state} learning requires evidence_id`);
	}
	assertLearningPolicySafe(options.pattern, options.metadata);

	return options.store.recordLearningPattern({
		runId: options.runId,
		scope: options.scope ?? "project",
		state,
		pattern: options.pattern,
		confidence: options.confidence,
		evidenceId: options.evidenceId,
		metadata: options.metadata,
		ts: options.now,
	});
}

export function promoteLearningPattern(
	options: PromoteLearningPatternOptions,
): PromoteLearningPatternResult {
	assertNonEmptyString(options.approvedBy, "approvedBy");
	const current = requireLearningPattern(options.store, options.id);
	const eligibility = evaluatePromotionEligibility(current, options.approvedBy);
	if (!eligibility.eligible) {
		throw new Error(`Learning pattern cannot be promoted: ${eligibility.failures.join("; ")}`);
	}

	const metadata = mergeMetadata(current.metadata, {
		approvedBy: options.approvedBy,
		promotionPolicy: "project-scope-audited",
	});
	const promoted = options.store.updateLearningPatternState({
		id: current.id,
		state: "promoted",
		metadata,
		ts: options.now,
	});
	if (!promoted) {
		throw new Error(`Learning pattern not found: ${current.id}`);
	}
	const decision = options.store.recordDecision({
		runId: promoted.runId,
		decisionType: "learning.promote",
		decision: "promote",
		rationale: `Approved project-scope learning promotion by ${options.approvedBy}.`,
		ts: options.now,
	});
	const knowledgeFile = options.write
		? writeProjectLearningFile(options.store, resolve(options.cwd ?? process.cwd()))
		: {
				path: projectLearningFilePath(resolve(options.cwd ?? process.cwd())),
				status: "not_requested" as const,
			};

	return {
		pattern: promoted,
		decisionId: decision.id,
		eligibility,
		knowledgeFile,
	};
}

export function retireLearningPattern(
	options: RetireLearningPatternOptions,
): RetireLearningPatternResult {
	assertNonEmptyString(options.reason, "retirement reason");
	const current = requireLearningPattern(options.store, options.id);
	const retired = options.store.updateLearningPatternState({
		id: current.id,
		state: "retired",
		metadata: mergeMetadata(current.metadata, { retiredReason: options.reason }),
		ts: options.now,
	});
	if (!retired) {
		throw new Error(`Learning pattern not found: ${current.id}`);
	}
	const decision = options.store.recordDecision({
		runId: retired.runId,
		decisionType: "learning.retire",
		decision: "retire",
		rationale: options.reason,
		ts: options.now,
	});
	const knowledgeFile = options.write
		? writeProjectLearningFile(options.store, resolve(options.cwd ?? process.cwd()))
		: {
				path: projectLearningFilePath(resolve(options.cwd ?? process.cwd())),
				status: "not_requested" as const,
			};

	return {
		pattern: retired,
		decisionId: decision.id,
		knowledgeFile,
	};
}

export function explainLearningPattern(
	options: ExplainLearningPatternOptions,
): ExplainLearningPatternResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const pattern = requireLearningPattern(options.store, options.id);
	return {
		pattern,
		eligibility: evaluatePromotionEligibility(pattern, "explain-only"),
		knowledgeFilePath: projectLearningFilePath(cwd),
		policy: {
			promotionConfidenceThreshold: LEARNING_PROMOTION_CONFIDENCE_THRESHOLD,
			cannotRelaxGates: true,
			projectScopeOnlyInMvp: true,
		},
	};
}

export function projectLearningFilePath(cwd: string): string {
	return join(cwd, ".paveda", "learning", "patterns.json");
}

export function evaluatePromotionEligibility(
	pattern: LearningPatternRecord,
	approvedBy: string,
): LearningPromotionEligibility {
	const failures: string[] = [];
	if (pattern.scope !== "project") {
		failures.push("only project-scope learning promotion is supported in MVP");
	}
	if (pattern.state !== "validated") {
		failures.push("pattern must be validated before promotion");
	}
	if (pattern.confidence < LEARNING_PROMOTION_CONFIDENCE_THRESHOLD) {
		failures.push(`confidence must be >= ${LEARNING_PROMOTION_CONFIDENCE_THRESHOLD}`);
	}
	if (!pattern.evidenceId) {
		failures.push("promotion requires linked evidence_id");
	}
	if (!hasValidationSupport(pattern.metadata)) {
		failures.push("promotion requires successfulRuns >= 3 or manualValidation metadata");
	}
	if (!hasEvidenceAuditPass(pattern.metadata)) {
		failures.push("promotion requires evidence audit pass metadata");
	}
	if (!approvedBy || approvedBy === "explain-only") {
		failures.push("promotion requires user approval");
	}
	try {
		assertLearningPolicySafe(pattern.pattern, pattern.metadata);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}

	return {
		eligible: failures.length === 0,
		failures,
		requirements: [
			"scope = project",
			"state = validated",
			`confidence >= ${LEARNING_PROMOTION_CONFIDENCE_THRESHOLD}`,
			"evidence_id is present",
			"successfulRuns >= 3 or manualValidation = true",
			"evidenceAudit = pass or evidenceAuditPassed = true",
			"user approval is present",
			"pattern does not relax gates, thresholds, required evidence, or release restrictions",
		],
	};
}

function writeProjectLearningFile(
	store: EventStore,
	cwd: string,
): LearningKnowledgeFileResult & { status: "written" } {
	const path = projectLearningFilePath(cwd);
	assertWritePathIsSafe(path);
	mkdirSync(dirname(path), { recursive: true });
	const current = readPromotedLearningFile(path);
	const approvedBy = new Map(
		current.patterns.map((pattern) => [pattern.id, pattern.approvedBy] as const),
	);
	const promoted = store
		.listLearningPatterns({ scope: "project", state: "promoted", limit: 500 })
		.map((pattern) => toPromotedFilePattern(pattern, approvedBy.get(pattern.id)))
		.sort((left, right) => left.id - right.id);
	const output: PromotedLearningFile = {
		schemaVersion: "1.0.0",
		generatedBy: "paveda learning promote",
		patterns: promoted,
	};
	writeTextFileSafely(path, `${JSON.stringify(output, null, 2)}\n`);

	return {
		path,
		status: "written",
		patternCount: promoted.length,
	};
}

function toPromotedFilePattern(
	pattern: LearningPatternRecord,
	existingApprovedBy: string | undefined,
): PromotedLearningFilePattern {
	if (pattern.scope !== "project" || !pattern.evidenceId || !pattern.promotedAt) {
		throw new Error(`Invalid promoted project learning pattern: ${pattern.id}`);
	}
	const metadata = asRecord(pattern.metadata);
	const approvedBy = readString(metadata.approvedBy) ?? existingApprovedBy ?? "unknown";
	return {
		id: pattern.id,
		runId: pattern.runId,
		scope: "project",
		pattern: pattern.pattern,
		confidence: pattern.confidence,
		evidenceId: pattern.evidenceId,
		promotedAt: pattern.promotedAt,
		approvedBy,
		metadata: pattern.metadata,
	};
}

function readPromotedLearningFile(path: string): PromotedLearningFile {
	if (!existsSync(path)) {
		return { schemaVersion: "1.0.0", generatedBy: "paveda learning promote", patterns: [] };
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PromotedLearningFile>;
	return {
		schemaVersion: "1.0.0",
		generatedBy: "paveda learning promote",
		patterns: Array.isArray(parsed.patterns) ? parsed.patterns.filter(isPromotedPattern) : [],
	};
}

function isPromotedPattern(value: unknown): value is PromotedLearningFilePattern {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value.id === "number" &&
		typeof value.runId === "string" &&
		value.scope === "project" &&
		typeof value.pattern === "string" &&
		typeof value.confidence === "number" &&
		typeof value.evidenceId === "number" &&
		typeof value.promotedAt === "number" &&
		typeof value.approvedBy === "string"
	);
}

function requireLearningPattern(store: EventStore, id: number): LearningPatternRecord {
	const pattern = store.getLearningPattern(id);
	if (!pattern) {
		throw new Error(`Learning pattern not found: ${id}`);
	}
	return pattern;
}

function assertLearningPolicySafe(pattern: string, metadata: unknown): void {
	const combined = `${pattern}\n${JSON.stringify(metadata ?? {})}`;
	const forbidden = [
		/\b(skip|bypass|disable|waive|relax)\b[\s\S]{0,80}\b(unit|e2e|gate|threshold|score|test|release)\b/i,
		/\b(lower|reduce)\b[\s\S]{0,80}\b(threshold|score)\b/i,
		/\bnot_applicable\b[\s\S]{0,80}\b(code|ui|api|infra|mixed|test)\b/i,
	];
	if (forbidden.some((patternRule) => patternRule.test(combined))) {
		throw new Error(
			"learning patterns cannot relax gates, thresholds, required evidence, or release restrictions",
		);
	}
}

function hasValidationSupport(metadata: unknown): boolean {
	const record = asRecord(metadata);
	return record.manualValidation === true || readNumber(record.successfulRuns) >= 3;
}

function hasEvidenceAuditPass(metadata: unknown): boolean {
	const record = asRecord(metadata);
	return record.evidenceAuditPassed === true || record.evidenceAudit === "pass";
}

function mergeMetadata(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	return {
		...asRecord(current),
		...patch,
	};
}

function assertNonEmptyString(value: string, label: string): void {
	if (value.length === 0) {
		throw new Error(`${label} must not be empty`);
	}
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
