import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
	type ArtifactRecord,
	type ArtifactRedactionStatus,
	EventStore,
	type EvidenceRecord,
	type EvidenceResult,
	type StoreScope,
	resolveStorePath,
} from "../store/index.js";

export type EvidenceProviderFailureBehavior = "fail" | "block" | "inconclusive";

export interface EvidenceProviderDefinition {
	id: string;
	kind: string;
	phaseId?: string | null;
	command: string[];
	requiredForTaskTypes: string[];
	timeoutMs: number;
	artifactGlobs: string[];
	redactionRequired: boolean;
	passExitCodes: number[];
	failureBehavior: EvidenceProviderFailureBehavior;
}

export interface CollectEvidenceOptions {
	cwd?: string;
	runId: string;
	kind?: string;
	providerId?: string;
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

export interface CollectEvidenceResult {
	cwd: string;
	runId: string;
	ok: boolean;
	providers: EvidenceProviderRunResult[];
	evidence: EvidenceRecord[];
	artifacts: ArtifactRecord[];
}

export interface EvidenceProviderRunResult {
	id: string;
	kind: string;
	status: "collected" | "skipped";
	command: string[];
	exitCode: number | null;
	result: EvidenceResult | null;
	evidenceId: string | null;
	artifactIds: number[];
	redactionStatus: ArtifactRedactionStatus | null;
	message: string;
}

interface EvidencePolicyFile {
	providers?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_PATTERN = /(api[_-]?key|secret|token|password)\s*[:=]/i;

export function collectEvidenceFromProviders(
	options: CollectEvidenceOptions,
): CollectEvidenceResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const store = new EventStore(
		options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
	);
	try {
		const run = store.getRun(options.runId);
		if (!run) {
			throw new Error(`Run does not exist: ${options.runId}`);
		}
		const providers = readEvidenceProviders(cwd).filter(
			(provider) =>
				(options.kind ? provider.kind === options.kind : true) &&
				(options.providerId ? provider.id === options.providerId : true),
		);
		const taskType = readRunTaskType(run.context);
		const providerResults: EvidenceProviderRunResult[] = [];
		const evidence: EvidenceRecord[] = [];
		const artifacts: ArtifactRecord[] = [];

		for (const provider of providers) {
			if (
				provider.requiredForTaskTypes.length > 0 &&
				!provider.requiredForTaskTypes.includes(taskType)
			) {
				providerResults.push({
					id: provider.id,
					kind: provider.kind,
					status: "skipped",
					command: provider.command,
					exitCode: null,
					result: null,
					evidenceId: null,
					artifactIds: [],
					redactionStatus: null,
					message: `provider does not apply to ${taskType} task`,
				});
				continue;
			}
			const result = runProvider(cwd, store, options.runId, provider, options.now ?? Date.now());
			providerResults.push(result.provider);
			evidence.push(result.evidence);
			artifacts.push(...result.artifacts);
		}

		return {
			cwd,
			runId: options.runId,
			ok: evidence.every((item) => item.result === "pass"),
			providers: providerResults,
			evidence,
			artifacts,
		};
	} finally {
		store.close();
	}
}

export function readEvidenceProviders(cwd: string): EvidenceProviderDefinition[] {
	const evidencePolicyPath = join(cwd, ".paveda", "evidence-policy.json");
	const testPolicyPath = join(cwd, ".paveda", "test-policy.json");
	const policyPath = existsSync(evidencePolicyPath) ? evidencePolicyPath : testPolicyPath;
	if (!existsSync(policyPath)) {
		return [];
	}
	const policy = JSON.parse(readFileSync(policyPath, "utf8")) as EvidencePolicyFile;
	const providers = Array.isArray(policy.providers) ? policy.providers : [];
	return providers
		.map(normalizeProvider)
		.filter((provider): provider is EvidenceProviderDefinition => Boolean(provider));
}

function runProvider(
	cwd: string,
	store: EventStore,
	runId: string,
	provider: EvidenceProviderDefinition,
	now: number,
): {
	provider: EvidenceProviderRunResult;
	evidence: EvidenceRecord;
	artifacts: ArtifactRecord[];
} {
	const spawned = spawnSync(provider.command[0] ?? "", provider.command.slice(1), {
		cwd,
		encoding: "utf8",
		timeout: provider.timeoutMs,
		maxBuffer: 10 * 1024 * 1024,
	});
	const exitCode = normalizeExitCode(spawned.status, spawned.error);
	const artifacts = captureArtifacts(cwd, store, runId, provider, now);
	const redactionFailed = artifacts.some((artifact) => artifact.redactionStatus === "failed");
	const commandPassed = provider.passExitCodes.includes(exitCode);
	const result = redactionFailed ? "fail" : commandPassed ? "pass" : provider.failureBehavior;
	const evidence = store.recordEvidence({
		runId,
		phaseId: provider.phaseId ?? null,
		evidenceId: provider.id,
		kind: provider.kind,
		result,
		command: provider.command.join(" "),
		exitCode,
		artifactId: artifacts[0]?.id ?? null,
		rationale: commandPassed
			? `${provider.id} provider command passed`
			: `${provider.id} provider command exited with ${exitCode}`,
		metadata: {
			providerId: provider.id,
			artifactIds: artifacts.map((artifact) => artifact.id),
			redactionFailed,
			signal: spawned.signal ?? null,
		},
		ts: now,
	});

	return {
		provider: {
			id: provider.id,
			kind: provider.kind,
			status: "collected",
			command: provider.command,
			exitCode,
			result,
			evidenceId: evidence.evidenceId,
			artifactIds: artifacts.map((artifact) => artifact.id),
			redactionStatus: summarizeRedactionStatus(artifacts),
			message: redactionFailed
				? "provider artifact redaction failed"
				: `provider recorded ${result} evidence`,
		},
		evidence,
		artifacts,
	};
}

function captureArtifacts(
	cwd: string,
	store: EventStore,
	runId: string,
	provider: EvidenceProviderDefinition,
	now: number,
): ArtifactRecord[] {
	const paths = expandArtifactGlobs(cwd, provider.artifactGlobs);
	return paths.map((path) => {
		const content = readFileSync(path);
		const redactionStatus = readArtifactRedactionStatus(content, provider.redactionRequired);
		return store.writeArtifact({
			runId,
			kind: `${provider.kind}-artifact`,
			fileName: safeArtifactFileName(provider.id, path),
			content,
			redactionStatus,
			metadata: {
				providerId: provider.id,
				sourcePath: relative(cwd, path).replaceAll("\\", "/"),
				sourceSha256: createHash("sha256").update(content).digest("hex"),
				redactionRequired: provider.redactionRequired,
			},
			createdAt: now,
		});
	});
}

function normalizeProvider(value: unknown): EvidenceProviderDefinition | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const provider = value as Record<string, unknown>;
	const id = readNonEmptyString(provider.id);
	const kind = readNonEmptyString(provider.kind);
	const command = readCommand(provider.command);
	if (!id || !kind || command.length === 0) {
		return null;
	}
	return {
		id,
		kind,
		phaseId: readNonEmptyString(provider.phaseId),
		command,
		requiredForTaskTypes: readStringArray(provider.requiredForTaskTypes),
		timeoutMs: readPositiveInteger(provider.timeoutMs) ?? DEFAULT_TIMEOUT_MS,
		artifactGlobs: readStringArray(provider.artifactGlobs),
		redactionRequired: provider.redactionRequired === true,
		passExitCodes: readNumberArray(provider.passExitCodes, [0]),
		failureBehavior: readFailureBehavior(provider.failureBehavior),
	};
}

function expandArtifactGlobs(cwd: string, patterns: readonly string[]): string[] {
	if (patterns.length === 0) {
		return [];
	}
	const files = collectFiles(cwd).filter((path) => !relative(cwd, path).startsWith(".paveda/"));
	const matched = new Set<string>();
	for (const pattern of patterns) {
		const regex = globToRegex(pattern);
		for (const file of files) {
			const relativePath = relative(cwd, file).replaceAll("\\", "/");
			if (regex.test(relativePath)) {
				matched.add(file);
			}
		}
	}
	return [...matched].sort();
}

function collectFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...collectFiles(path));
		} else if (stat.isFile()) {
			files.push(path);
		}
	}
	return files;
}

function globToRegex(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", "\0")
		.replaceAll("*", "[^/]*")
		.replaceAll("\0", ".*")
		.replaceAll("?", ".");
	return new RegExp(`^${escaped}$`);
}

function readArtifactRedactionStatus(
	content: Buffer,
	redactionRequired: boolean,
): ArtifactRedactionStatus {
	if (!redactionRequired) {
		return "not_required";
	}
	return SECRET_PATTERN.test(content.toString("utf8")) ? "failed" : "redacted";
}

function safeArtifactFileName(providerId: string, sourcePath: string): string {
	return `${providerId}-${basename(sourcePath)}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function summarizeRedactionStatus(
	artifacts: readonly ArtifactRecord[],
): ArtifactRedactionStatus | null {
	if (artifacts.length === 0) {
		return null;
	}
	if (artifacts.some((artifact) => artifact.redactionStatus === "failed")) {
		return "failed";
	}
	if (artifacts.some((artifact) => artifact.redactionStatus === "redacted")) {
		return "redacted";
	}
	return "not_required";
}

function normalizeExitCode(status: number | null, error: Error | undefined): number {
	if (typeof status === "number") {
		return status;
	}
	return error ? 1 : 0;
}

function readCommand(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string" && item.length > 0);
	}
	return typeof value === "string" && value.length > 0 ? ["/bin/sh", "-lc", value] : [];
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.length > 0)
		: [];
}

function readNumberArray(value: unknown, fallback: number[]): number[] {
	const values = Array.isArray(value)
		? value.filter((item): item is number => Number.isInteger(item))
		: [];
	return values.length > 0 ? values : fallback;
}

function readPositiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function readFailureBehavior(value: unknown): EvidenceProviderFailureBehavior {
	return value === "fail" || value === "block" || value === "inconclusive" ? value : "inconclusive";
}

function readRunTaskType(context: unknown): string {
	if (typeof context !== "object" || context === null) {
		return "code";
	}
	const taskType = (context as { taskType?: unknown }).taskType;
	return typeof taskType === "string" ? taskType : "code";
}
