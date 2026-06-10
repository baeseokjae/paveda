import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPathDoesNotUseSymlinks } from "../fs-safety.js";
import {
	type HostSkillBundleTarget,
	type InstallHostSkillBundleOptions,
	type InstallHostSkillBundleResult,
	installHostSkillBundle,
	parseHostSkillBundleTarget,
} from "../host-bundles/index.js";
import {
	EventStore,
	type PavedaProfile,
	type StoreScope,
	generateUuidV7,
	resolveStorePath,
} from "../store/index.js";

export type ProjectionKind = "instruction" | "skill" | "context" | "config" | "sidecar";
export type ProjectionEntryState = "clean" | "missing" | "drifted" | "overridden";
export type DriftResolution = "import" | "regenerate" | "approve-override";

export interface PavedaSourceLayoutResult {
	cwd: string;
	written: boolean;
	manifestPath: string;
	contractPath: string;
	capabilitiesPath: string;
	testPolicyPath: string;
	profilePath: string;
	hostDeclarationPath: string;
	gitignorePath: string;
	createdDirectories: string[];
	writtenFiles: string[];
}

export interface ProjectionIndex {
	schemaVersion: 1;
	generatedAt: string;
	generatorVersion: string;
	sourceManifestHash: string;
	entries: ProjectionIndexEntry[];
	overrides: ProjectionOverrideRecord[];
}

export interface ProjectionIndexEntry {
	id: string;
	host: HostSkillBundleTarget;
	projectionPath: string;
	projectionKind: ProjectionKind;
	managedBy: "paveda";
	sourceContractVersion: string;
	sourceManifestHash: string;
	sourceAssetHashes: Record<string, string>;
	contentHash: string;
	snapshotPath: string;
	generatedAt: string;
	generatorVersion: string;
	driftPolicy: "block";
	manualOverrideId?: string;
	importedSourcePath?: string;
}

export interface ProjectionOverrideRecord {
	id: string;
	host: HostSkillBundleTarget;
	projectionPath: string;
	reason: string;
	actor: string;
	scope: string;
	compensatingControl: string;
	approvedAt: string;
	expiresAt: string;
	sourceManifestHash: string;
	expectedContentHash: string;
	currentContentHash: string;
	runId: string;
	ledgerDecisionId: number;
}

export interface ProjectionStatusEntry extends ProjectionIndexEntry {
	state: ProjectionEntryState;
	currentHash: string | null;
	override: ProjectionOverrideRecord | null;
	recoveryCommands: string[];
}

export interface ProjectionStatusResult {
	cwd: string;
	host?: HostSkillBundleTarget;
	ok: boolean;
	indexPath: string;
	indexExists: boolean;
	entries: ProjectionStatusEntry[];
	recoveryCommands: string[];
}

export interface ProjectionDiffResult {
	cwd: string;
	host?: HostSkillBundleTarget;
	ok: boolean;
	diffs: ProjectionDiffEntry[];
	recoveryCommands: string[];
}

export interface ProjectionDiffEntry {
	path: string;
	state: ProjectionEntryState;
	expectedHash: string;
	currentHash: string | null;
	diff: string[];
}

export interface ProjectionRegenerateOptions extends BaseProjectionOptions {
	targetRoot?: string;
	skills?: string[];
	builtinRoots?: string[];
	force?: boolean;
	write?: boolean;
}

export interface ProjectionRegenerateResult {
	cwd: string;
	host: HostSkillBundleTarget;
	written: boolean;
	profile: PavedaProfile;
	bundle: InstallHostSkillBundleResult;
	source: PavedaSourceLayoutResult;
	status: ProjectionStatusResult;
}

export interface ProjectionImportResult {
	cwd: string;
	host: HostSkillBundleTarget;
	projectionPath: string;
	written: boolean;
	importPath: string;
	status: ProjectionStatusResult;
}

export interface ProjectionOverrideResult {
	cwd: string;
	host: HostSkillBundleTarget;
	projectionPath: string;
	written: boolean;
	override: ProjectionOverrideRecord;
	status: ProjectionStatusResult;
}

interface BaseProjectionOptions {
	cwd?: string;
	host: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
}

interface ProjectionCommandOptions extends BaseProjectionOptions {
	path?: string;
}

interface ProjectionImportOptions extends ProjectionCommandOptions {
	reason?: string;
	write?: boolean;
}

interface ProjectionOverrideOptions extends ProjectionCommandOptions {
	reason: string;
	actor?: string;
	scope?: string;
	expiresAt?: string | number;
	compensatingControl?: string;
	write?: boolean;
	dbPath?: string;
	storeScope?: StoreScope;
	now?: number;
}

interface WritePavedaSourceLayoutOptions {
	cwd: string;
	host: HostSkillBundleTarget;
	profile?: PavedaProfile;
	write: boolean;
}

interface RecordProjectionIndexOptions {
	cwd: string;
	host: HostSkillBundleTarget;
	bundle: InstallHostSkillBundleResult;
	write: boolean;
}

interface ProjectionTarget {
	path: string;
	kind: ProjectionKind;
}

interface SourceAssetPaths {
	contract: string;
	profile: string;
	host: string | null;
	harnessManifest: string;
	capabilitiesSchema: string;
}

const GENERATOR_VERSION = "paveda.projection.v1";
const DEFAULT_PROFILE: PavedaProfile = "strict";
const CONTRACT_VERSION = "1.0.0";
const TEXT_EXTENSIONS = new Set([
	".json",
	".jsonl",
	".md",
	".mjs",
	".sh",
	".ts",
	".txt",
	".yaml",
	".yml",
]);

export function writePavedaSourceLayout(
	options: WritePavedaSourceLayoutOptions,
): PavedaSourceLayoutResult {
	const cwd = resolve(options.cwd);
	const profile = options.profile ?? DEFAULT_PROFILE;
	assertPavedaProfileValue(profile);
	const sourceAssets = resolveSourceAssetPaths(options.host, profile);
	const createdDirectories = [
		".paveda",
		".paveda/hosts",
		".paveda/profiles",
		".paveda/projections",
		".paveda/projections/snapshots",
		".paveda/learning",
		".paveda/conformance",
	];
	const manifestPath = join(cwd, ".paveda", "manifest.json");
	const contractPath = join(cwd, ".paveda", "contract.json");
	const capabilitiesPath = join(cwd, ".paveda", "capabilities.json");
	const testPolicyPath = join(cwd, ".paveda", "test-policy.json");
	const profilePath = join(cwd, ".paveda", "profiles", `${profile}.json`);
	const hostDeclarationPath = join(cwd, ".paveda", "hosts", `${options.host}.json`);
	const gitignorePath = join(cwd, ".paveda", ".gitignore");
	const writtenFiles = [
		formatProjectPath(cwd, manifestPath),
		formatProjectPath(cwd, contractPath),
		formatProjectPath(cwd, capabilitiesPath),
		formatProjectPath(cwd, testPolicyPath),
		formatProjectPath(cwd, profilePath),
		formatProjectPath(cwd, hostDeclarationPath),
		formatProjectPath(cwd, gitignorePath),
	];

	if (options.write) {
		for (const directory of createdDirectories) {
			const fullPath = join(cwd, directory);
			assertPathDoesNotUseSymlinks(fullPath, "Paveda directory");
			mkdirSync(fullPath, { recursive: true });
		}

		writeJsonFile(manifestPath, buildManifest(cwd, options.host, profile, sourceAssets));
		copyAssetFile(sourceAssets.contract, contractPath);
		copyAssetFile(sourceAssets.profile, profilePath);
		if (sourceAssets.host) {
			copyAssetFile(sourceAssets.host, hostDeclarationPath);
		} else {
			writeJsonFile(hostDeclarationPath, buildCanonicalHarnessTargetDeclaration());
		}
		writeJsonFile(capabilitiesPath, buildCapabilitiesPolicy(options.host, sourceAssets.host));
		writeJsonFile(testPolicyPath, buildTestPolicy(profile, sourceAssets.profile));
		writeTextFile(
			gitignorePath,
			["ledger/", "artifacts/", "state/", "learning/cache/", "tmp/", ""].join("\n"),
		);
	}

	return {
		cwd,
		written: options.write,
		manifestPath,
		contractPath,
		capabilitiesPath,
		testPolicyPath,
		profilePath,
		hostDeclarationPath,
		gitignorePath,
		createdDirectories,
		writtenFiles,
	};
}

export function recordProjectionIndex(options: RecordProjectionIndexOptions): ProjectionIndex {
	const cwd = resolve(options.cwd);
	const manifestPath = projectionManifestPath(cwd);
	const sourceManifestHash = existsSync(manifestPath)
		? hashFile(manifestPath)
		: hashText(
				stableStringify(
					buildManifest(
						cwd,
						options.host,
						DEFAULT_PROFILE,
						resolveSourceAssetPaths(options.host, DEFAULT_PROFILE),
					),
				),
			);
	const existing = readProjectionIndex(cwd);
	const sourceAssetHashes = buildSourceAssetHashes(options.host, sourceManifestHash);
	const generatedAt = new Date().toISOString();
	const entries = collectProjectionFiles(cwd, options.host, options.bundle)
		.map((target) =>
			buildProjectionIndexEntry(
				cwd,
				options.host,
				target,
				sourceManifestHash,
				sourceAssetHashes,
				generatedAt,
			),
		)
		.sort((left, right) => left.projectionPath.localeCompare(right.projectionPath));
	const existingOverrideByPath = new Map(
		(existing?.overrides ?? []).map((override) => [
			projectionKey(override.host, override.projectionPath),
			override,
		]),
	);
	const entriesWithOverrides = entries.map((entry) => {
		const override = existingOverrideByPath.get(projectionKey(entry.host, entry.projectionPath));
		return override ? { ...entry, manualOverrideId: override.id } : entry;
	});
	const index: ProjectionIndex = {
		schemaVersion: 1,
		generatedAt,
		generatorVersion: GENERATOR_VERSION,
		sourceManifestHash,
		entries: entriesWithOverrides,
		overrides: existing?.overrides ?? [],
	};

	if (options.write) {
		writeProjectionSnapshots(cwd, index.entries);
		writeProjectionIndex(cwd, index);
	}

	return index;
}

export function checkProjectionStatus(options: ProjectionCommandOptions): ProjectionStatusResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = options.host === undefined ? undefined : parseHostSkillBundleTarget(options.host);
	const path = options.path ? normalizeProjectPath(options.path) : undefined;
	const index = readProjectionIndex(cwd);
	const indexPath = projectionIndexPath(cwd);
	if (!index) {
		return {
			cwd,
			...(host ? { host } : {}),
			ok: false,
			indexPath,
			indexExists: false,
			entries: [],
			recoveryCommands: [`paveda init --host ${host ?? "<host>"} --cwd ${shellQuote(cwd)} --write`],
		};
	}

	const now = Date.now();
	const entries = index.entries
		.filter((entry) => (host ? entry.host === host : true))
		.filter((entry) => (path ? entry.projectionPath === path : true))
		.map((entry) => statusEntry(cwd, entry, index.overrides, now));
	const ok = entries.every((entry) => entry.state === "clean" || entry.state === "overridden");
	const recoveryCommands = ok ? [] : buildRecoveryCommands(host, path, cwd);

	return {
		cwd,
		...(host ? { host } : {}),
		ok,
		indexPath,
		indexExists: true,
		entries,
		recoveryCommands,
	};
}

export function diffProjections(options: ProjectionCommandOptions): ProjectionDiffResult {
	const status = checkProjectionStatus(options);
	const diffs = status.entries
		.filter((entry) => entry.state !== "clean")
		.map((entry) => buildProjectionDiff(status.cwd, entry));

	return {
		cwd: status.cwd,
		...(status.host ? { host: status.host } : {}),
		ok: status.ok,
		diffs,
		recoveryCommands: status.recoveryCommands,
	};
}

export function regenerateProjections(
	options: ProjectionRegenerateOptions,
): ProjectionRegenerateResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfile(options.profile);
	assertReleaseProfileIsSupported(profile);
	const write = Boolean(options.write);
	const source = writePavedaSourceLayout({ cwd, host, profile, write });
	const bundleOptions: InstallHostSkillBundleOptions = {
		host,
		cwd,
		targetRoot: options.targetRoot,
		skills: options.skills,
		builtinRoots: options.builtinRoots,
		write,
		force: options.force ?? write,
	};
	const bundle = installHostSkillBundle(bundleOptions);
	recordProjectionIndex({ cwd, host, bundle, write });
	const status = checkProjectionStatus({ cwd, host });

	return {
		cwd,
		host,
		written: write,
		profile,
		bundle,
		source,
		status,
	};
}

export function importProjectionDrift(options: ProjectionImportOptions): ProjectionImportResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfile(options.profile);
	assertReleaseProfileIsSupported(profile);
	const projectionPath = normalizeProjectPath(requireProjectionPath(options.path));
	const index = requireProjectionIndex(cwd);
	const entry = requireProjectionEntry(index, host, projectionPath);
	const absoluteProjectionPath = join(cwd, projectionPath);
	if (!existsSync(absoluteProjectionPath)) {
		throw new Error(`Projection file is missing: ${projectionPath}`);
	}
	const importPath = join(cwd, ".paveda", "hosts", host, "imports", ...projectionPath.split("/"));
	const write = Boolean(options.write);

	if (write) {
		assertPathDoesNotUseSymlinks(importPath, "Paveda import path");
		mkdirSync(dirname(importPath), { recursive: true });
		copyFileSync(absoluteProjectionPath, importPath);
		chmodSync(importPath, statSync(absoluteProjectionPath).mode);
		const updatedEntry: ProjectionIndexEntry = {
			...entry,
			contentHash: hashFile(absoluteProjectionPath),
			snapshotPath: snapshotProjectPath(host, projectionPath),
			importedSourcePath: formatProjectPath(cwd, importPath),
			manualOverrideId: undefined,
		};
		writeProjectionSnapshot(cwd, updatedEntry, absoluteProjectionPath);
		writeProjectionIndex(
			cwd,
			replaceProjectionEntry(
				index,
				updatedEntry,
				(index.overrides ?? []).filter(
					(override) =>
						projectionKey(override.host, override.projectionPath) !==
						projectionKey(host, projectionPath),
				),
			),
		);
	}

	return {
		cwd,
		host,
		projectionPath,
		written: write,
		importPath,
		status: checkProjectionStatus({ cwd, host, path: projectionPath }),
	};
}

export function approveProjectionOverride(
	options: ProjectionOverrideOptions,
): ProjectionOverrideResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfile(options.profile);
	assertReleaseProfileIsSupported(profile);
	const projectionPath = normalizeProjectPath(requireProjectionPath(options.path));
	const index = requireProjectionIndex(cwd);
	const entry = requireProjectionEntry(index, host, projectionPath);
	const absoluteProjectionPath = join(cwd, projectionPath);
	if (!existsSync(absoluteProjectionPath)) {
		throw new Error(`Projection file is missing: ${projectionPath}`);
	}
	const currentContentHash = hashFile(absoluteProjectionPath);
	if (currentContentHash === entry.contentHash) {
		throw new Error(`Projection is clean and does not need an override: ${projectionPath}`);
	}
	const now = options.now ?? Date.now();
	const expiresAt = parseOverrideExpiry(options.expiresAt, now);
	const overrideId = generateUuidV7(now);
	const runId = generateUuidV7(now + 1);
	const write = Boolean(options.write);
	let ledgerDecisionId = 0;

	if (write) {
		const store = new EventStore(
			options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd),
		);
		try {
			store.createRun({
				runId,
				objective: `Approve projection drift override for ${projectionPath}`,
				acceptanceCriteria: [
					"Override is audited",
					"Override has an expiry",
					"Drift remains visible in projection status",
				],
				profile,
				host,
				metadata: {
					projectionPath,
					overrideId,
				},
				ts: now,
			});
			const decision = store.recordDecision({
				runId,
				phaseId: "projection-drift",
				decisionType: "projection_drift_override",
				decision: "approve-override",
				rationale: options.reason,
				override: true,
				expiresAt,
				ts: now,
			});
			ledgerDecisionId = decision.id;
		} finally {
			store.close();
		}
	}

	const override: ProjectionOverrideRecord = {
		id: overrideId,
		host,
		projectionPath,
		reason: options.reason,
		actor: options.actor ?? "unknown",
		scope: options.scope ?? "project",
		compensatingControl: options.compensatingControl ?? "manual review before expiry",
		approvedAt: new Date(now).toISOString(),
		expiresAt: new Date(expiresAt).toISOString(),
		sourceManifestHash: entry.sourceManifestHash,
		expectedContentHash: entry.contentHash,
		currentContentHash,
		runId,
		ledgerDecisionId,
	};

	if (write) {
		const updatedEntry = { ...entry, manualOverrideId: override.id };
		const overrides = [
			...(index.overrides ?? []).filter(
				(item) =>
					projectionKey(item.host, item.projectionPath) !== projectionKey(host, projectionPath),
			),
			override,
		].sort((left, right) => left.projectionPath.localeCompare(right.projectionPath));
		writeProjectionIndex(cwd, replaceProjectionEntry(index, updatedEntry, overrides));
	}

	return {
		cwd,
		host,
		projectionPath,
		written: write,
		override,
		status: checkProjectionStatus({ cwd, host, path: projectionPath }),
	};
}

export function parsePavedaProfile(value: string | undefined): PavedaProfile {
	if (!value) {
		return DEFAULT_PROFILE;
	}
	if (value === "fast" || value === "standard" || value === "strict" || value === "release") {
		return value;
	}
	throw new Error(`Invalid Paveda profile: ${value}`);
}

function buildManifest(
	cwd: string,
	host: HostSkillBundleTarget,
	profile: PavedaProfile,
	sourceAssets: SourceAssetPaths,
): unknown {
	return {
		schemaVersion: 1,
		generatedBy: "paveda",
		contract: {
			id: "paveda.universal.v1",
			version: CONTRACT_VERSION,
			path: ".paveda/contract.json",
			packageAssetHash: hashFile(sourceAssets.contract),
		},
		profile: {
			name: profile,
			path: `.paveda/profiles/${profile}.json`,
			packageAssetHash: hashFile(sourceAssets.profile),
		},
		hosts: [
			{
				host,
				declarationPath: `.paveda/hosts/${host}.json`,
				packageAssetHash: sourceAssets.host ? hashFile(sourceAssets.host) : null,
				canonicalTarget: sourceAssets.host === null,
			},
		],
		projections: {
			indexPath: ".paveda/projections/index.json",
			defaultDriftPolicy: "block",
			allowedResolutions: ["import", "regenerate", "approve-override"],
		},
		packageAssets: {
			harnessManifestHash: hashFile(sourceAssets.harnessManifest),
			capabilitiesSchemaHash: hashFile(sourceAssets.capabilitiesSchema),
		},
		paths: {
			projectRoot: formatProjectPath(cwd, cwd),
			ledger: ".paveda/ledger/paveda.db",
			artifacts: ".paveda/artifacts",
		},
	};
}

function buildCapabilitiesPolicy(
	host: HostSkillBundleTarget,
	hostDeclarationPath: string | null,
): unknown {
	const hostDeclaration = hostDeclarationPath
		? (readJsonFile(hostDeclarationPath) as { capabilities?: unknown[] })
		: { capabilities: [] };
	return {
		schemaVersion: 1,
		host,
		capabilitySource: hostDeclarationPath ? "host-declaration" : "canonical-harness",
		capabilities: hostDeclaration.capabilities ?? [],
	};
}

function buildCanonicalHarnessTargetDeclaration(): unknown {
	return {
		schemaVersion: 1,
		host: "harness",
		displayName: "Paveda Harness",
		role: "canonical-bundle-target",
		capabilities: [],
		projectionTargets: [
			{ path: ".harness/AGENTS.md", kind: "instruction", driftPolicy: "block" },
			{ path: ".harness/skills", kind: "skill", driftPolicy: "block" },
		],
	};
}

function buildTestPolicy(profile: PavedaProfile, profilePath: string): unknown {
	const profileManifest = readJsonFile(profilePath) as { requiredGates?: unknown[] };
	return {
		schemaVersion: 1,
		profile,
		missingTestInfrastructure: "ask_setup_sprint",
		codeChangingGatePolicy: "block_without_unit_and_e2e",
		notApplicablePolicy: "requires_rationale_for_non_testable_changes",
		requiredGates: profileManifest.requiredGates ?? [],
	};
}

function collectProjectionFiles(
	cwd: string,
	host: HostSkillBundleTarget,
	bundle: InstallHostSkillBundleResult,
): ProjectionTarget[] {
	const targets: ProjectionTarget[] = [];

	if (bundle.instructionFile && existsSync(bundle.instructionFile.targetPath)) {
		targets.push({
			path: formatProjectPath(cwd, bundle.instructionFile.targetPath),
			kind: "instruction",
		});
	}

	for (const contextModule of bundle.contextModules) {
		if (existsSync(contextModule.targetPath)) {
			targets.push({
				path: formatProjectPath(cwd, contextModule.targetPath),
				kind: "context",
			});
		}
	}

	if (bundle.hostConfigFile && existsSync(bundle.hostConfigFile.targetPath)) {
		targets.push({
			path: formatProjectPath(cwd, bundle.hostConfigFile.targetPath),
			kind: "config",
		});
	}

	for (const skill of bundle.skills) {
		const skillDirectory = dirname(skill.targetPath);
		if (existsSync(skillDirectory)) {
			targets.push(
				...collectFiles(skillDirectory).map((path) => ({
					path: formatProjectPath(cwd, path),
					kind: "skill" as const,
				})),
			);
		}
	}

	for (const target of readHostProjectionTargets(host)) {
		if (target.kind !== "sidecar") {
			continue;
		}
		const sidecarPath = join(cwd, target.path);
		if (existsSync(sidecarPath)) {
			targets.push({
				path: target.path,
				kind: "sidecar",
			});
		}
	}

	return uniqueProjectionTargets(targets);
}

function buildProjectionIndexEntry(
	cwd: string,
	host: HostSkillBundleTarget,
	target: ProjectionTarget,
	sourceManifestHash: string,
	sourceAssetHashes: Record<string, string>,
	generatedAt: string,
): ProjectionIndexEntry {
	const absolutePath = join(cwd, target.path);
	return {
		id: `${host}:${target.path}`,
		host,
		projectionPath: target.path,
		projectionKind: target.kind,
		managedBy: "paveda",
		sourceContractVersion: CONTRACT_VERSION,
		sourceManifestHash,
		sourceAssetHashes,
		contentHash: hashFile(absolutePath),
		snapshotPath: snapshotProjectPath(host, target.path),
		generatedAt,
		generatorVersion: GENERATOR_VERSION,
		driftPolicy: "block",
	};
}

function statusEntry(
	cwd: string,
	entry: ProjectionIndexEntry,
	overrides: readonly ProjectionOverrideRecord[],
	now: number,
): ProjectionStatusEntry {
	const absolutePath = join(cwd, entry.projectionPath);
	const currentHash = existsSync(absolutePath) ? hashFile(absolutePath) : null;
	const activeOverride =
		entry.manualOverrideId === undefined
			? null
			: (overrides.find((override) => override.id === entry.manualOverrideId) ?? null);
	const overrideActive = activeOverride !== null && Date.parse(activeOverride.expiresAt) > now;
	const state: ProjectionEntryState =
		currentHash === null
			? "missing"
			: currentHash === entry.contentHash
				? "clean"
				: overrideActive
					? "overridden"
					: "drifted";

	return {
		...entry,
		state,
		currentHash,
		override: overrideActive ? activeOverride : null,
		recoveryCommands:
			state === "clean" || state === "overridden"
				? []
				: buildRecoveryCommands(entry.host, entry.projectionPath, cwd),
	};
}

function buildProjectionDiff(cwd: string, entry: ProjectionStatusEntry): ProjectionDiffEntry {
	const snapshotPath = join(cwd, entry.snapshotPath);
	const projectionPath = join(cwd, entry.projectionPath);
	if (!existsSync(projectionPath)) {
		return {
			path: entry.projectionPath,
			state: entry.state,
			expectedHash: entry.contentHash,
			currentHash: null,
			diff: [`missing: ${entry.projectionPath}`],
		};
	}
	if (!existsSync(snapshotPath) || !isTextPath(projectionPath) || !isTextPath(snapshotPath)) {
		return {
			path: entry.projectionPath,
			state: entry.state,
			expectedHash: entry.contentHash,
			currentHash: entry.currentHash,
			diff: [
				`expected hash: ${entry.contentHash}`,
				`current hash: ${entry.currentHash ?? "missing"}`,
			],
		};
	}

	return {
		path: entry.projectionPath,
		state: entry.state,
		expectedHash: entry.contentHash,
		currentHash: entry.currentHash,
		diff: simpleUnifiedDiff(
			readFileSync(snapshotPath, "utf8"),
			readFileSync(projectionPath, "utf8"),
			entry.snapshotPath,
			entry.projectionPath,
		),
	};
}

function simpleUnifiedDiff(
	expected: string,
	actual: string,
	expectedPath: string,
	actualPath: string,
): string[] {
	if (expected === actual) {
		return [];
	}
	const expectedLines = expected.split(/\r?\n/);
	const actualLines = actual.split(/\r?\n/);
	return [
		`--- ${expectedPath}`,
		`+++ ${actualPath}`,
		...expectedLines.map((line) => `- ${line}`),
		...actualLines.map((line) => `+ ${line}`),
	];
}

function buildRecoveryCommands(
	host: HostSkillBundleTarget | undefined,
	path: string | undefined,
	cwd: string,
): string[] {
	const hostValue = host ?? "<host>";
	const pathArg = path ? ` --path ${shellQuote(path)}` : "";
	return [
		`paveda projection diff --host ${hostValue} --cwd ${shellQuote(cwd)}${pathArg}`,
		`paveda projection regenerate --host ${hostValue} --cwd ${shellQuote(cwd)} --write`,
		`paveda projection import --host ${hostValue} --cwd ${shellQuote(cwd)}${pathArg} --write`,
		`paveda projection approve-override --host ${hostValue} --cwd ${shellQuote(cwd)}${pathArg} --reason <reason> --expires-at <ISO> --write`,
	];
}

function replaceProjectionEntry(
	index: ProjectionIndex,
	entry: ProjectionIndexEntry,
	overrides = index.overrides,
): ProjectionIndex {
	return {
		...index,
		generatedAt: new Date().toISOString(),
		entries: index.entries
			.map((item) =>
				projectionKey(item.host, item.projectionPath) ===
				projectionKey(entry.host, entry.projectionPath)
					? entry
					: item,
			)
			.sort((left, right) => left.projectionPath.localeCompare(right.projectionPath)),
		overrides,
	};
}

function requireProjectionIndex(cwd: string): ProjectionIndex {
	const index = readProjectionIndex(cwd);
	if (!index) {
		throw new Error("Projection index is missing. Run paveda init first.");
	}
	return index;
}

function requireProjectionEntry(
	index: ProjectionIndex,
	host: HostSkillBundleTarget,
	path: string,
): ProjectionIndexEntry {
	const entry = index.entries.find((item) => item.host === host && item.projectionPath === path);
	if (!entry) {
		throw new Error(`Projection is not managed by Paveda: ${path}`);
	}
	return entry;
}

function readProjectionIndex(cwd: string): ProjectionIndex | null {
	const indexPath = projectionIndexPath(cwd);
	if (!existsSync(indexPath)) {
		return null;
	}
	return readJsonFile(indexPath) as ProjectionIndex;
}

function writeProjectionIndex(cwd: string, index: ProjectionIndex): void {
	writeJsonFile(projectionIndexPath(cwd), index);
}

function projectionManifestPath(cwd: string): string {
	return join(cwd, ".paveda", "manifest.json");
}

function projectionIndexPath(cwd: string): string {
	return join(cwd, ".paveda", "projections", "index.json");
}

function writeProjectionSnapshots(cwd: string, entries: readonly ProjectionIndexEntry[]): void {
	for (const entry of entries) {
		writeProjectionSnapshot(cwd, entry, join(cwd, entry.projectionPath));
	}
}

function writeProjectionSnapshot(
	cwd: string,
	entry: ProjectionIndexEntry,
	sourcePath: string,
): void {
	const snapshotPath = join(cwd, entry.snapshotPath);
	assertPathDoesNotUseSymlinks(snapshotPath, "Projection snapshot path");
	mkdirSync(dirname(snapshotPath), { recursive: true });
	copyFileSync(sourcePath, snapshotPath);
	chmodSync(snapshotPath, statSync(sourcePath).mode);
}

function snapshotProjectPath(host: HostSkillBundleTarget, path: string): string {
	const snapshotPath = path.startsWith("/") ? join("__absolute__", path.slice(1)) : path;
	return normalizeProjectPath(join(".paveda", "projections", "snapshots", host, snapshotPath));
}

function resolveSourceAssetPaths(
	host: HostSkillBundleTarget,
	profile: PavedaProfile,
): SourceAssetPaths {
	const root = resolvePackageHarnessRoot();
	return {
		contract: join(root, "contracts", "universal-contract.v1.json"),
		profile: join(root, "contracts", "profiles", `${profile}.json`),
		host: resolveOptionalAsset(join(root, "hosts", `${host}.json`)),
		harnessManifest: join(root, "manifest.json"),
		capabilitiesSchema: join(root, "contracts", "schemas", "capabilities.schema.json"),
	};
}

function buildSourceAssetHashes(
	host: HostSkillBundleTarget,
	sourceManifestHash: string,
): Record<string, string> {
	const sourceAssets = resolveSourceAssetPaths(host, DEFAULT_PROFILE);
	return {
		".paveda/manifest.json": sourceManifestHash,
		"assets/harness/manifest.json": hashFile(sourceAssets.harnessManifest),
		"assets/harness/contracts/universal-contract.v1.json": hashFile(sourceAssets.contract),
		...(sourceAssets.host
			? { [`assets/harness/hosts/${host}.json`]: hashFile(sourceAssets.host) }
			: {}),
	};
}

function readHostProjectionTargets(host: HostSkillBundleTarget): ProjectionTarget[] {
	const hostDeclarationPath = resolveSourceAssetPaths(host, DEFAULT_PROFILE).host;
	if (!hostDeclarationPath) {
		return [];
	}
	const hostDeclaration = readJsonFile(hostDeclarationPath) as {
		projectionTargets?: Array<{ path?: unknown; kind?: unknown }>;
	};
	return (hostDeclaration.projectionTargets ?? [])
		.filter((target) => typeof target.path === "string" && typeof target.kind === "string")
		.map((target) => ({
			path: normalizeProjectPath(String(target.path)),
			kind: parseProjectionKind(String(target.kind)),
		}));
}

function parseProjectionKind(value: string): ProjectionKind {
	if (
		value === "instruction" ||
		value === "skill" ||
		value === "context" ||
		value === "config" ||
		value === "sidecar"
	) {
		return value;
	}
	throw new Error(`Invalid projection kind: ${value}`);
}

function collectFiles(root: string): string[] {
	if (!existsSync(root)) {
		return [];
	}
	const stats = lstatSync(root);
	if (stats.isSymbolicLink()) {
		throw new Error(`Projection target must not use symlinks: ${root}`);
	}
	if (stats.isFile()) {
		return [root];
	}
	if (!stats.isDirectory()) {
		return [];
	}

	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isSymbolicLink()) {
			throw new Error(`Projection target must not use symlinks: ${path}`);
		}
		if (entry.isDirectory()) {
			return collectFiles(path);
		}
		return entry.isFile() ? [path] : [];
	});
}

function uniqueProjectionTargets(targets: readonly ProjectionTarget[]): ProjectionTarget[] {
	const seen = new Set<string>();
	return targets
		.filter((target) => {
			const key = `${target.kind}:${target.path}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeProjectPath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
	if (normalized.startsWith("/")) {
		if (normalized.split("/").some((part) => part === "..")) {
			throw new Error(`Invalid projection path: ${path}`);
		}
		return normalized.replace(/\/+/g, "/");
	}
	if (
		normalized.length === 0 ||
		normalized.split("/").some((part) => part === ".." || part.length === 0)
	) {
		throw new Error(`Invalid projection path: ${path}`);
	}
	return normalized;
}

function requireProjectionPath(path: string | undefined): string {
	if (!path) {
		throw new Error("Missing required option: --path");
	}
	return path;
}

function parseOverrideExpiry(value: string | number | undefined, now: number): number {
	if (value === undefined) {
		throw new Error("Missing required option: --expires-at");
	}
	const expiresAt = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(expiresAt)) {
		throw new Error(`Invalid --expires-at value: ${value}`);
	}
	if (expiresAt <= now) {
		throw new Error("--expires-at must be in the future");
	}
	return expiresAt;
}

function assertReleaseProfileIsSupported(profile: PavedaProfile): void {
	if (profile === "release") {
		throw new Error(
			"Release profile execution is not_supported_in_mvp. Supported MVP execution profiles: fast, standard, strict.",
		);
	}
}

function assertPavedaProfileValue(value: unknown): asserts value is PavedaProfile {
	parsePavedaProfile(String(value));
}

function copyAssetFile(sourcePath: string, targetPath: string): void {
	assertPathDoesNotUseSymlinks(targetPath, "Paveda file path");
	mkdirSync(dirname(targetPath), { recursive: true });
	copyFileSync(sourcePath, targetPath);
	chmodSync(targetPath, statSync(sourcePath).mode);
}

function writeJsonFile(path: string, value: unknown): void {
	writeTextFile(path, `${stableStringify(value)}\n`);
}

function writeTextFile(path: string, content: string): void {
	assertPathDoesNotUseSymlinks(path, "Paveda file path");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path: string): string {
	return hashText(readFileSync(path));
}

function hashText(input: string | Buffer): string {
	return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJson);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, sortJson(nested)]),
		);
	}
	return value;
}

function resolvePackageHarnessRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../../assets/harness");
}

function resolveOptionalAsset(path: string): string | null {
	return existsSync(path) ? path : null;
}

function formatProjectPath(cwd: string, targetPath: string): string {
	const relativePath = relative(cwd, targetPath);
	if (relativePath.length === 0) {
		return ".";
	}
	if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
		return normalizeProjectPath(relativePath);
	}
	return normalizeProjectPath(targetPath);
}

function projectionKey(host: HostSkillBundleTarget, path: string): string {
	return `${host}:${path}`;
}

function isTextPath(path: string): boolean {
	return basename(path) === "SKILL.md" || TEXT_EXTENSIONS.has(extname(path));
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}
