import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertWritePathIsSafe, writeTextFileSafely } from "../fs-safety.js";
import type {
	EventStore,
	EvidenceRecord,
	InstinctScope,
	LearningPatternRecord,
	LearningState,
} from "../store/index.js";

export type LearningPromotionScope = InstinctScope | "shared";

export const PROJECT_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD = 0.9;
export const USER_SHARED_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD = 0.95;
export const LEARNING_PROMOTION_CONFIDENCE_THRESHOLD =
	PROJECT_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD;

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
	scope?: LearningPromotionScope;
	approvedBy: string;
	write?: boolean;
	now?: number;
	userLearningPath?: string;
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

export interface ExportSharedLearningPatternOptions {
	store: EventStore;
	id: number;
	out: string;
	now?: number;
}

export interface ImportSharedLearningPatternOptions {
	cwd?: string;
	path: string;
	reviewedBy: string;
	now?: number;
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
		projectPromotionConfidenceThreshold: number;
		userSharedPromotionConfidenceThreshold: number;
		cannotRelaxGates: true;
		supportedScopes: LearningPromotionScope[];
	};
}

export interface LearningKnowledgeFileResult {
	path: string;
	status: "written" | "not_requested";
	patternCount?: number;
}

export interface ExportSharedLearningPatternResult {
	path: string;
	status: "written";
	pattern: PromotedLearningFilePattern;
}

export interface ImportSharedLearningPatternResult {
	path: string;
	status: "written";
	imported: PromotedLearningFilePattern;
	patternCount: number;
}

interface PromotedLearningFile {
	schemaVersion: "1.0.0";
	generatedBy: "paveda learning promote";
	patterns: PromotedLearningFilePattern[];
}

interface PromotedLearningFilePattern {
	id: number;
	runId: string;
	scope: LearningPromotionScope;
	pattern: string;
	confidence: number;
	evidenceId: number;
	promotedAt: number;
	approvedBy: string;
	sourceRun: string;
	evidenceHash: string;
	redactionHash: string | null;
	conformanceHash: string | null;
	reviewDecision: {
		decision: "approved";
		reviewedBy: string;
		reviewedAt: number;
	};
	metadata: unknown;
}

interface SharedLearningExportFile {
	schemaVersion: "1.0.0";
	generatedBy: "paveda learning export-shared";
	exportedAt: number;
	pattern: PromotedLearningFilePattern;
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
	const requestedScope = options.scope ?? current.scope;
	const eligibility = evaluatePromotionEligibility(current, options.approvedBy, requestedScope);
	if (!eligibility.eligible) {
		throw new Error(`Learning pattern cannot be promoted: ${eligibility.failures.join("; ")}`);
	}
	const evidence = requireLinkedEvidence(options.store, current);
	const now = options.now ?? Date.now();

	const metadata = mergeMetadata(current.metadata, {
		approvedBy: options.approvedBy,
		promotionPolicy: `${requestedScope}-scope-audited`,
		sourceRun: current.runId,
		evidenceHash: hashEvidence(evidence),
		redactionHash: redactionHash(current.metadata),
		conformanceHash: conformanceHash(current.metadata),
		reviewDecision: {
			decision: "approved",
			reviewedBy: options.approvedBy,
			reviewedAt: now,
		},
	});
	const promoted = options.store.updateLearningPatternState({
		id: current.id,
		state: "promoted",
		metadata,
		ts: now,
	});
	if (!promoted) {
		throw new Error(`Learning pattern not found: ${current.id}`);
	}
	const decision = options.store.recordDecision({
		runId: promoted.runId,
		decisionType: "learning.promote",
		decision: "promote",
		rationale: `Approved ${requestedScope}-scope learning promotion by ${options.approvedBy}.`,
		ts: now,
	});
	const knowledgeFile = options.write
		? writeLearningFile({
				store: options.store,
				cwd: resolve(options.cwd ?? process.cwd()),
				scope: requestedScope,
				userLearningPath: options.userLearningPath,
			})
		: {
				path: learningFilePathForScope({
					cwd: resolve(options.cwd ?? process.cwd()),
					scope: requestedScope,
					userLearningPath: options.userLearningPath,
				}),
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
		? writeLearningFile({
				store: options.store,
				cwd: resolve(options.cwd ?? process.cwd()),
				scope: retired.scope,
			})
		: {
				path: learningFilePathForScope({
					cwd: resolve(options.cwd ?? process.cwd()),
					scope: retired.scope,
				}),
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
		eligibility: evaluatePromotionEligibility(pattern, "explain-only", pattern.scope),
		knowledgeFilePath: learningFilePathForScope({ cwd, scope: pattern.scope }),
		policy: {
			projectPromotionConfidenceThreshold: PROJECT_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD,
			userSharedPromotionConfidenceThreshold: USER_SHARED_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD,
			cannotRelaxGates: true,
			supportedScopes: ["project", "user", "shared"],
		},
	};
}

export function projectLearningFilePath(cwd: string): string {
	return join(cwd, ".paveda", "learning", "patterns.json");
}

export function userLearningFilePath(): string {
	return join(homedir(), ".paveda", "learning", "patterns.json");
}

export function sharedLearningCandidatesFilePath(cwd: string): string {
	return join(cwd, ".paveda", "learning", "shared-candidates.json");
}

export function exportSharedLearningPattern(
	options: ExportSharedLearningPatternOptions,
): ExportSharedLearningPatternResult {
	const current = requireLearningPattern(options.store, options.id);
	if (current.scope !== "shared" || current.state !== "promoted") {
		throw new Error("Only promoted shared-scope learning can be exported");
	}
	assertLearningPolicySafe(current.pattern, current.metadata);
	const pattern = toPromotedFilePattern(current, undefined);
	const output: SharedLearningExportFile = {
		schemaVersion: "1.0.0",
		generatedBy: "paveda learning export-shared",
		exportedAt: options.now ?? Date.now(),
		pattern,
	};
	assertWritePathIsSafe(options.out);
	mkdirSync(dirname(options.out), { recursive: true });
	writeTextFileSafely(options.out, `${JSON.stringify(output, null, 2)}\n`);
	return {
		path: resolve(options.out),
		status: "written",
		pattern,
	};
}

export function importSharedLearningPattern(
	options: ImportSharedLearningPatternOptions,
): ImportSharedLearningPatternResult {
	assertNonEmptyString(options.reviewedBy, "reviewedBy");
	const cwd = resolve(options.cwd ?? process.cwd());
	const imported = readSharedLearningExport(options.path);
	assertLearningPolicySafe(imported.pattern, imported.metadata);
	const now = options.now ?? Date.now();
	const reviewed: PromotedLearningFilePattern = {
		...imported,
		scope: "shared",
		reviewDecision: {
			decision: "approved",
			reviewedBy: options.reviewedBy,
			reviewedAt: now,
		},
		metadata: mergeMetadata(imported.metadata, {
			importReview: {
				decision: "approved",
				reviewedBy: options.reviewedBy,
				reviewedAt: now,
			},
		}),
	};
	const path = sharedLearningCandidatesFilePath(cwd);
	const current = readPromotedLearningFile(path);
	const nextPatterns = [
		...current.patterns.filter((pattern) => pattern.id !== reviewed.id),
		reviewed,
	].sort((left, right) => left.id - right.id);
	writeLearningFileContent(path, nextPatterns);
	return {
		path,
		status: "written",
		imported: reviewed,
		patternCount: nextPatterns.length,
	};
}

export function evaluatePromotionEligibility(
	pattern: LearningPatternRecord,
	approvedBy: string,
	requestedScope = pattern.scope,
): LearningPromotionEligibility {
	const failures: string[] = [];
	const policy = promotionPolicyForScope(requestedScope);
	if (pattern.scope !== requestedScope) {
		failures.push(`pattern scope must be ${requestedScope}`);
	}
	if (pattern.state !== "validated") {
		failures.push("pattern must be validated before promotion");
	}
	if (pattern.confidence < policy.confidenceThreshold) {
		failures.push(`confidence must be >= ${policy.confidenceThreshold}`);
	}
	if (!pattern.evidenceId) {
		failures.push("promotion requires linked evidence_id");
	}
	if (requestedScope === "project" && !hasValidationSupport(pattern.metadata)) {
		failures.push("promotion requires successfulRuns >= 3 or manualValidation metadata");
	}
	if (!hasEvidenceAuditPass(pattern.metadata)) {
		failures.push("promotion requires evidence audit pass metadata");
	}
	if (requestedScope === "user" || requestedScope === "shared") {
		if (!hasRedactionPass(pattern.metadata)) {
			failures.push(`${requestedScope} promotion requires redaction pass metadata`);
		}
		if (!hasConformancePass(pattern.metadata)) {
			failures.push(`${requestedScope} promotion requires conformance pass metadata`);
		}
	}
	if (!approvedBy || approvedBy === "explain-only") {
		failures.push(
			requestedScope === "project"
				? "promotion requires user approval"
				: `${requestedScope} promotion requires reviewer approval`,
		);
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
			`scope = ${requestedScope}`,
			"state = validated",
			`confidence >= ${policy.confidenceThreshold}`,
			"evidence_id is present",
			...(requestedScope === "project"
				? ["successfulRuns >= 3 or manualValidation = true"]
				: ["redaction pass metadata", "conformance pass metadata", "reviewer approval"]),
			"evidenceAudit = pass or evidenceAuditPassed = true",
			"pattern does not relax gates, thresholds, required evidence, or release restrictions",
		],
	};
}

function writeLearningFile(options: {
	store: EventStore;
	cwd: string;
	scope: LearningPromotionScope;
	userLearningPath?: string;
}): LearningKnowledgeFileResult & { status: "written" } {
	const path = learningFilePathForScope(options);
	const current = readPromotedLearningFile(path);
	const approvedBy = new Map(
		current.patterns.map((pattern) => [pattern.id, pattern.approvedBy] as const),
	);
	const promoted = options.store
		.listLearningPatterns({ scope: options.scope, state: "promoted", limit: 500 })
		.map((pattern) => toPromotedFilePattern(pattern, approvedBy.get(pattern.id)))
		.sort((left, right) => left.id - right.id);
	writeLearningFileContent(path, promoted);

	return {
		path,
		status: "written",
		patternCount: promoted.length,
	};
}

function learningFilePathForScope(options: {
	cwd: string;
	scope: LearningPromotionScope;
	userLearningPath?: string;
}): string {
	if (options.scope === "user") {
		return options.userLearningPath ?? userLearningFilePath();
	}
	if (options.scope === "shared") {
		return sharedLearningCandidatesFilePath(options.cwd);
	}
	return projectLearningFilePath(options.cwd);
}

function writeLearningFileContent(path: string, patterns: PromotedLearningFilePattern[]): void {
	assertWritePathIsSafe(path);
	mkdirSync(dirname(path), { recursive: true });
	const output: PromotedLearningFile = {
		schemaVersion: "1.0.0",
		generatedBy: "paveda learning promote",
		patterns,
	};
	writeTextFileSafely(path, `${JSON.stringify(output, null, 2)}\n`);
}

function toPromotedFilePattern(
	pattern: LearningPatternRecord,
	existingApprovedBy: string | undefined,
): PromotedLearningFilePattern {
	if (!pattern.evidenceId || !pattern.promotedAt) {
		throw new Error(`Invalid promoted learning pattern: ${pattern.id}`);
	}
	const metadata = asRecord(pattern.metadata);
	const approvedBy = readString(metadata.approvedBy) ?? existingApprovedBy ?? "unknown";
	const evidenceHashValue = readString(metadata.evidenceHash) ?? hashJson(pattern.evidenceId);
	const redactionHashValue = readString(metadata.redactionHash) ?? null;
	const conformanceHashValue = readString(metadata.conformanceHash) ?? null;
	return {
		id: pattern.id,
		runId: pattern.runId,
		scope: pattern.scope,
		pattern: pattern.pattern,
		confidence: pattern.confidence,
		evidenceId: pattern.evidenceId,
		promotedAt: pattern.promotedAt,
		approvedBy,
		sourceRun: readString(metadata.sourceRun) ?? pattern.runId,
		evidenceHash: evidenceHashValue,
		redactionHash: redactionHashValue,
		conformanceHash: conformanceHashValue,
		reviewDecision: readReviewDecision(metadata.reviewDecision, approvedBy, pattern.promotedAt),
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
		(value.scope === "project" || value.scope === "user" || value.scope === "shared") &&
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

function requireLinkedEvidence(store: EventStore, pattern: LearningPatternRecord): EvidenceRecord {
	if (!pattern.evidenceId) {
		throw new Error(`Learning pattern requires linked evidence: ${pattern.id}`);
	}
	const evidence = store
		.listEvidence(pattern.runId)
		.find((candidate) => candidate.id === pattern.evidenceId);
	if (!evidence) {
		throw new Error(`Learning evidence not found: ${pattern.evidenceId}`);
	}
	return evidence;
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

function hasRedactionPass(metadata: unknown): boolean {
	const record = asRecord(metadata);
	return (
		record.redactionPassed === true ||
		record.redaction === "pass" ||
		record.redactionAudit === "pass"
	);
}

function hasConformancePass(metadata: unknown): boolean {
	const record = asRecord(metadata);
	return (
		record.conformancePassed === true ||
		record.conformance === "pass" ||
		record.conformanceAudit === "pass"
	);
}

function promotionPolicyForScope(scope: LearningPromotionScope): {
	confidenceThreshold: number;
} {
	return {
		confidenceThreshold:
			scope === "project"
				? PROJECT_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD
				: USER_SHARED_LEARNING_PROMOTION_CONFIDENCE_THRESHOLD,
	};
}

function redactionHash(metadata: unknown): string | null {
	const record = asRecord(metadata);
	return (
		readString(record.redactionHash) ??
		(hasRedactionPass(metadata)
			? hashJson({
					redaction: record.redaction,
					redactionAudit: record.redactionAudit,
					redactionPassed: record.redactionPassed,
				})
			: null)
	);
}

function conformanceHash(metadata: unknown): string | null {
	const record = asRecord(metadata);
	return (
		readString(record.conformanceHash) ??
		(hasConformancePass(metadata)
			? hashJson({
					conformance: record.conformance,
					conformanceAudit: record.conformanceAudit,
					conformancePassed: record.conformancePassed,
				})
			: null)
	);
}

function mergeMetadata(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	return {
		...asRecord(current),
		...patch,
	};
}

function hashEvidence(evidence: EvidenceRecord): string {
	return hashJson({
		id: evidence.id,
		evidenceId: evidence.evidenceId,
		kind: evidence.kind,
		result: evidence.result,
		command: evidence.command,
		exitCode: evidence.exitCode,
		rationale: evidence.rationale,
		artifactId: evidence.artifactId,
		metadata: evidence.metadata,
	});
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function readReviewDecision(
	value: unknown,
	approvedBy: string,
	promotedAt: number,
): PromotedLearningFilePattern["reviewDecision"] {
	const record = asRecord(value);
	return {
		decision: "approved",
		reviewedBy: readString(record.reviewedBy) ?? approvedBy,
		reviewedAt: readNumber(record.reviewedAt) || promotedAt,
	};
}

function readSharedLearningExport(path: string): PromotedLearningFilePattern {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SharedLearningExportFile>;
	if (!isPromotedPattern(parsed.pattern)) {
		throw new Error("Shared learning import file must contain a promoted pattern");
	}
	if (parsed.pattern.scope !== "shared") {
		throw new Error("Shared learning import file must contain shared-scope learning");
	}
	return parsed.pattern;
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
