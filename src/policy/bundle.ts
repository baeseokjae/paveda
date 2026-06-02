import { createHash, sign as signPayload, verify as verifyPayload } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../version.js";
import { listHostCapabilities } from "./host-capability.js";
import { DEFAULT_POLICY_RULES } from "./rules.js";
import type { HostCapability, PolicyRuntimeSource } from "./types.js";

export interface PolicyBundle {
	schemaVersion: 1;
	generatedAt: string;
	issuer: string;
	policyRuntime: {
		name: "paveda";
		version: string;
	};
	rules: PolicyBundleRule[];
	hostCapabilities: HostCapability[];
}

export interface PolicyBundleRule {
	id: string;
	description: string;
	version?: number;
	fingerprint?: string;
	parameters?: Record<string, unknown>;
}

export interface PolicyBundleArtifact {
	bundle: PolicyBundle;
	canonicalSha256: string;
}

export interface SignedPolicyBundle extends PolicyBundleArtifact {
	signature: {
		algorithm: "ed25519";
		value: string;
		keyId?: string;
	};
}

export interface CreatePolicyBundleOptions {
	generatedAt?: string;
	issuer?: string;
	version?: string;
}

export interface SignPolicyBundleOptions {
	privateKeyPem: string;
	keyId?: string;
}

export interface VerifySignedPolicyBundleOptions {
	publicKeyPem: string;
}

export interface TrustedPolicyKey {
	keyId?: string;
	publicKeyPem: string;
}

export interface VerifySignedPolicyBundleWithKeyringOptions {
	keys: TrustedPolicyKey[];
}

export interface PolicyBundleVerificationResult {
	ok: boolean;
	expectedSha256: string;
	actualSha256: string;
	keyId?: string;
	reason?: "digest_mismatch" | "invalid_signature" | "key_not_found" | "unsupported_algorithm";
}

export interface PolicyBundleSummary {
	schemaVersion: 1;
	issuer: string;
	generatedAt: string;
	runtimeVersion: string;
	canonicalSha256: string;
	signatureAlgorithm: "ed25519";
	keyId?: string;
	ruleCount: number;
	hostCount: number;
}

export interface PolicyBundleCacheEntry {
	schemaVersion: 1;
	cachedAt: string;
	source: string;
	summary: PolicyBundleSummary;
	verification: PolicyBundleVerificationResult;
	signedBundle: SignedPolicyBundle;
}

export interface CreatePolicyBundleCacheEntryOptions {
	source: string;
	cachedAt?: string;
}

export interface ResolvePolicyRuntimeSourceOptions {
	cachePath?: string;
	cwd?: string;
}

export interface PolicyRuntimeSourceResolution {
	ok: boolean;
	policySource: PolicyRuntimeSource;
	cachePath?: string;
	cacheEntry?: PolicyBundleCacheEntry;
	runtimeDrift?: PolicyBundleRuntimeDrift;
	error?: string;
}

export interface PolicyBundleRuntimeDrift {
	ok: boolean;
	bundleRuntimeVersion: string;
	localRuntimeVersion: string;
	runtimeVersionMatches: boolean;
	missingRuleIds: string[];
	extraRuleIds: string[];
	changedRules: PolicyBundleRuleDrift[];
	duplicateRuleIds: string[];
	missingHostIds: string[];
	extraHostIds: string[];
	changedHostCapabilities: PolicyBundleHostCapabilityDrift[];
	duplicateHostIds: string[];
}

export interface PolicyBundleRuleDrift {
	id: string;
	bundleDescription?: string;
	localDescription?: string;
	bundleVersion?: number;
	localVersion?: number;
	bundleFingerprint?: string;
	localFingerprint?: string;
	bundleParameters?: Record<string, unknown>;
	localParameters?: Record<string, unknown>;
}

export interface PolicyBundleHostCapabilityDrift {
	host: string;
	bundleCapability?: HostCapability;
	localCapability?: HostCapability;
}

export function createPolicyBundle(options: CreatePolicyBundleOptions = {}): PolicyBundle {
	return {
		schemaVersion: 1,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		issuer: options.issuer ?? "local",
		policyRuntime: {
			name: "paveda",
			version: options.version ?? VERSION,
		},
		rules: DEFAULT_POLICY_RULES.map((rule) => ({
			id: rule.id,
			description: rule.description,
			...(rule.version ? { version: rule.version } : {}),
			...(rule.fingerprint ? { fingerprint: rule.fingerprint } : {}),
			...(rule.parameters ? { parameters: rule.parameters } : {}),
		})),
		hostCapabilities: listHostCapabilities(),
	};
}

export function createPolicyBundleArtifact(bundle: PolicyBundle): PolicyBundleArtifact {
	return {
		bundle,
		canonicalSha256: digestPolicyBundle(bundle),
	};
}

export function signPolicyBundle(
	bundle: PolicyBundle,
	options: SignPolicyBundleOptions,
): SignedPolicyBundle {
	const canonical = canonicalPolicyJson(bundle);
	const signature = signPayload(null, Buffer.from(canonical), options.privateKeyPem).toString(
		"base64",
	);

	return {
		bundle,
		canonicalSha256: digestPolicyBundle(bundle),
		signature: {
			algorithm: "ed25519",
			value: signature,
			...(options.keyId ? { keyId: options.keyId } : {}),
		},
	};
}

export function verifySignedPolicyBundle(
	signedBundle: SignedPolicyBundle,
	options: VerifySignedPolicyBundleOptions,
): PolicyBundleVerificationResult {
	const actualSha256 = digestPolicyBundle(signedBundle.bundle);
	const expectedSha256 = signedBundle.canonicalSha256;
	const keyId = signedBundle.signature.keyId;

	if (signedBundle.signature.algorithm !== "ed25519") {
		return {
			ok: false,
			expectedSha256,
			actualSha256,
			keyId,
			reason: "unsupported_algorithm",
		};
	}

	if (actualSha256 !== expectedSha256) {
		return {
			ok: false,
			expectedSha256,
			actualSha256,
			keyId,
			reason: "digest_mismatch",
		};
	}

	try {
		const ok = verifyPayload(
			null,
			Buffer.from(canonicalPolicyJson(signedBundle.bundle)),
			options.publicKeyPem,
			Buffer.from(signedBundle.signature.value, "base64"),
		);

		return {
			ok,
			expectedSha256,
			actualSha256,
			keyId,
			...(ok ? {} : { reason: "invalid_signature" }),
		};
	} catch {
		return {
			ok: false,
			expectedSha256,
			actualSha256,
			keyId,
			reason: "invalid_signature",
		};
	}
}

export function verifySignedPolicyBundleWithKeyring(
	signedBundle: SignedPolicyBundle,
	options: VerifySignedPolicyBundleWithKeyringOptions,
): PolicyBundleVerificationResult {
	const digestResult = verifyPolicyBundleDigest(signedBundle);
	if (!digestResult.ok) {
		return digestResult;
	}

	if (signedBundle.signature.algorithm !== "ed25519") {
		return {
			...digestResult,
			ok: false,
			reason: "unsupported_algorithm",
		};
	}

	const signedKeyId = signedBundle.signature.keyId;
	const candidateKeys = signedKeyId
		? options.keys.filter((key) => key.keyId === signedKeyId || key.keyId === undefined)
		: options.keys;

	if (candidateKeys.length === 0) {
		return {
			...digestResult,
			ok: false,
			keyId: signedKeyId,
			reason: "key_not_found",
		};
	}

	for (const key of candidateKeys) {
		const result = verifySignedPolicyBundle(signedBundle, { publicKeyPem: key.publicKeyPem });
		if (result.ok) {
			return {
				...result,
				keyId: result.keyId ?? key.keyId,
			};
		}
	}

	return {
		...digestResult,
		ok: false,
		keyId: signedKeyId,
		reason: "invalid_signature",
	};
}

export async function fetchSignedPolicyBundle(source: string): Promise<SignedPolicyBundle> {
	const text = await readPolicyBundleSource(source);
	try {
		return assertSignedPolicyBundle(JSON.parse(text) as unknown);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Policy bundle source must be valid JSON");
		}
		throw error;
	}
}

export function summarizePolicyBundle(signedBundle: SignedPolicyBundle): PolicyBundleSummary {
	return {
		schemaVersion: 1,
		issuer: signedBundle.bundle.issuer,
		generatedAt: signedBundle.bundle.generatedAt,
		runtimeVersion: signedBundle.bundle.policyRuntime.version,
		canonicalSha256: signedBundle.canonicalSha256,
		signatureAlgorithm: signedBundle.signature.algorithm,
		...(signedBundle.signature.keyId ? { keyId: signedBundle.signature.keyId } : {}),
		ruleCount: signedBundle.bundle.rules.length,
		hostCount: signedBundle.bundle.hostCapabilities.length,
	};
}

export function createPolicyBundleCacheEntry(
	signedBundle: SignedPolicyBundle,
	verification: PolicyBundleVerificationResult,
	options: CreatePolicyBundleCacheEntryOptions,
): PolicyBundleCacheEntry {
	return {
		schemaVersion: 1,
		cachedAt: options.cachedAt ?? new Date().toISOString(),
		source: options.source,
		summary: summarizePolicyBundle(signedBundle),
		verification,
		signedBundle,
	};
}

export function readPolicyBundleCacheEntry(path: string): PolicyBundleCacheEntry {
	try {
		return assertPolicyBundleCacheEntry(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Policy bundle cache must be valid JSON");
		}
		throw error;
	}
}

export function resolvePolicyRuntimeSourceFromCache(path: string): PolicyRuntimeSource {
	const cacheEntry = readPolicyBundleCacheEntry(path);
	return resolvePolicyRuntimeSourceFromCacheEntry(cacheEntry, path);
}

export function resolvePolicyRuntimeSourceFromCacheEntry(
	cacheEntry: PolicyBundleCacheEntry,
	path: string,
): PolicyRuntimeSource {
	if (!cacheEntry.verification.ok) {
		throw new Error(
			`Policy bundle cache is not verified: ${cacheEntry.verification.reason ?? "unknown"}`,
		);
	}

	const digestVerification = verifyPolicyBundleDigest(cacheEntry.signedBundle);
	if (!digestVerification.ok) {
		throw new Error(`Policy bundle cache digest mismatch: ${digestVerification.reason}`);
	}

	if (cacheEntry.summary.canonicalSha256 !== cacheEntry.signedBundle.canonicalSha256) {
		throw new Error("Policy bundle cache summary digest does not match signed bundle");
	}

	return {
		type: "bundle-cache",
		source: cacheEntry.source,
		cachePath: path,
		cachedAt: cacheEntry.cachedAt,
		issuer: cacheEntry.summary.issuer,
		generatedAt: cacheEntry.summary.generatedAt,
		runtimeVersion: cacheEntry.summary.runtimeVersion,
		canonicalSha256: cacheEntry.summary.canonicalSha256,
		...(cacheEntry.summary.keyId ? { keyId: cacheEntry.summary.keyId } : {}),
	};
}

export function resolvePolicyRuntimeSource(
	options: ResolvePolicyRuntimeSourceOptions = {},
): PolicyRuntimeSourceResolution {
	if (!options.cachePath) {
		return {
			ok: true,
			policySource: { type: "local" },
		};
	}

	const cachePath = resolvePolicyCachePath(options.cachePath, options.cwd);
	try {
		const cacheEntry = readPolicyBundleCacheEntry(cachePath);
		return {
			ok: true,
			cachePath,
			cacheEntry,
			policySource: resolvePolicyRuntimeSourceFromCacheEntry(cacheEntry, cachePath),
			runtimeDrift: comparePolicyBundleToRuntime(cacheEntry.signedBundle.bundle),
		};
	} catch (error) {
		return {
			ok: false,
			cachePath,
			policySource: { type: "local" },
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function comparePolicyBundleToRuntime(bundle: PolicyBundle): PolicyBundleRuntimeDrift {
	const localBundle = createPolicyBundle({
		issuer: bundle.issuer,
		generatedAt: bundle.generatedAt,
		version: VERSION,
	});
	const bundleRules = indexBy(bundle.rules, (rule) => rule.id);
	const localRules = indexBy(localBundle.rules, (rule) => rule.id);
	const bundleHosts = indexBy(bundle.hostCapabilities, (capability) => capability.host);
	const localHosts = indexBy(localBundle.hostCapabilities, (capability) => capability.host);
	const missingRuleIds = [...localRules.keys()].filter((id) => !bundleRules.has(id)).sort();
	const extraRuleIds = [...bundleRules.keys()].filter((id) => !localRules.has(id)).sort();
	const changedRules = [...localRules.entries()]
		.flatMap(([id, localRule]) => {
			const bundleRule = bundleRules.get(id);
			if (!bundleRule || policyBundleRulesMatch(bundleRule, localRule)) {
				return [];
			}
			return [
				{
					id,
					bundleDescription: bundleRule.description,
					localDescription: localRule.description,
					...(bundleRule.version !== undefined ? { bundleVersion: bundleRule.version } : {}),
					...(localRule.version !== undefined ? { localVersion: localRule.version } : {}),
					...(bundleRule.fingerprint !== undefined
						? { bundleFingerprint: bundleRule.fingerprint }
						: {}),
					...(localRule.fingerprint !== undefined
						? { localFingerprint: localRule.fingerprint }
						: {}),
					...(bundleRule.parameters ? { bundleParameters: bundleRule.parameters } : {}),
					...(localRule.parameters ? { localParameters: localRule.parameters } : {}),
				},
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const missingHostIds = [...localHosts.keys()].filter((host) => !bundleHosts.has(host)).sort();
	const extraHostIds = [...bundleHosts.keys()].filter((host) => !localHosts.has(host)).sort();
	const changedHostCapabilities = [...localHosts.entries()]
		.flatMap(([host, localCapability]) => {
			const bundleCapability = bundleHosts.get(host);
			if (
				!bundleCapability ||
				canonicalPolicyJson(bundleCapability) === canonicalPolicyJson(localCapability)
			) {
				return [];
			}
			return [
				{
					host,
					bundleCapability,
					localCapability,
				},
			];
		})
		.sort((left, right) => left.host.localeCompare(right.host));
	const duplicateRuleIds = duplicateIds(bundle.rules.map((rule) => rule.id));
	const duplicateHostIds = duplicateIds(
		bundle.hostCapabilities.map((capability) => capability.host),
	);
	const runtimeVersionMatches = bundle.policyRuntime.version === VERSION;

	return {
		ok:
			missingRuleIds.length === 0 &&
			extraRuleIds.length === 0 &&
			changedRules.length === 0 &&
			duplicateRuleIds.length === 0 &&
			missingHostIds.length === 0 &&
			extraHostIds.length === 0 &&
			changedHostCapabilities.length === 0 &&
			duplicateHostIds.length === 0,
		bundleRuntimeVersion: bundle.policyRuntime.version,
		localRuntimeVersion: VERSION,
		runtimeVersionMatches,
		missingRuleIds,
		extraRuleIds,
		changedRules,
		duplicateRuleIds,
		missingHostIds,
		extraHostIds,
		changedHostCapabilities,
		duplicateHostIds,
	};
}

function policyBundleRulesMatch(left: PolicyBundleRule, right: PolicyBundleRule): boolean {
	return (
		left.description === right.description &&
		left.version === right.version &&
		left.fingerprint === right.fingerprint &&
		canonicalPolicyJson(left.parameters ?? {}) === canonicalPolicyJson(right.parameters ?? {})
	);
}

export function digestPolicyBundle(bundle: PolicyBundle): string {
	return createHash("sha256").update(canonicalPolicyJson(bundle)).digest("hex");
}

export function canonicalPolicyJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

export function assertSignedPolicyBundle(value: unknown): SignedPolicyBundle {
	if (!isSignedPolicyBundle(value)) {
		throw new Error("Policy bundle must be a signed policy bundle artifact");
	}

	return value;
}

export function assertPolicyBundleCacheEntry(value: unknown): PolicyBundleCacheEntry {
	if (!isPolicyBundleCacheEntry(value)) {
		throw new Error("Policy bundle cache must be a policy bundle cache entry");
	}

	return value;
}

function isSignedPolicyBundle(value: unknown): value is SignedPolicyBundle {
	if (!isRecord(value)) {
		return false;
	}

	const signature = value.signature;
	return (
		isPolicyBundle(value.bundle) &&
		typeof value.canonicalSha256 === "string" &&
		isRecord(signature) &&
		signature.algorithm === "ed25519" &&
		typeof signature.value === "string" &&
		(signature.keyId === undefined || typeof signature.keyId === "string")
	);
}

function isPolicyBundleCacheEntry(value: unknown): value is PolicyBundleCacheEntry {
	if (!isRecord(value)) {
		return false;
	}

	return (
		value.schemaVersion === 1 &&
		typeof value.cachedAt === "string" &&
		typeof value.source === "string" &&
		isPolicyBundleSummary(value.summary) &&
		isPolicyBundleVerificationResult(value.verification) &&
		isSignedPolicyBundle(value.signedBundle)
	);
}

function isPolicyBundleSummary(value: unknown): value is PolicyBundleSummary {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		typeof value.issuer === "string" &&
		typeof value.generatedAt === "string" &&
		typeof value.runtimeVersion === "string" &&
		typeof value.canonicalSha256 === "string" &&
		value.signatureAlgorithm === "ed25519" &&
		(value.keyId === undefined || typeof value.keyId === "string") &&
		typeof value.ruleCount === "number" &&
		typeof value.hostCount === "number"
	);
}

function isPolicyBundleVerificationResult(value: unknown): value is PolicyBundleVerificationResult {
	return (
		isRecord(value) &&
		typeof value.ok === "boolean" &&
		typeof value.expectedSha256 === "string" &&
		typeof value.actualSha256 === "string" &&
		(value.keyId === undefined || typeof value.keyId === "string") &&
		(value.reason === undefined ||
			value.reason === "digest_mismatch" ||
			value.reason === "invalid_signature" ||
			value.reason === "key_not_found" ||
			value.reason === "unsupported_algorithm")
	);
}

function isPolicyBundle(value: unknown): value is PolicyBundle {
	if (!isRecord(value)) {
		return false;
	}

	return (
		value.schemaVersion === 1 &&
		typeof value.generatedAt === "string" &&
		typeof value.issuer === "string" &&
		isRecord(value.policyRuntime) &&
		value.policyRuntime.name === "paveda" &&
		typeof value.policyRuntime.version === "string" &&
		Array.isArray(value.rules) &&
		Array.isArray(value.hostCapabilities)
	);
}

function verifyPolicyBundleDigest(
	signedBundle: SignedPolicyBundle,
): PolicyBundleVerificationResult {
	const actualSha256 = digestPolicyBundle(signedBundle.bundle);
	const expectedSha256 = signedBundle.canonicalSha256;
	const keyId = signedBundle.signature.keyId;

	if (actualSha256 !== expectedSha256) {
		return {
			ok: false,
			expectedSha256,
			actualSha256,
			keyId,
			reason: "digest_mismatch",
		};
	}

	return {
		ok: true,
		expectedSha256,
		actualSha256,
		keyId,
	};
}

async function readPolicyBundleSource(source: string): Promise<string> {
	if (source.startsWith("https://") || source.startsWith("http://")) {
		const response = await fetch(source);
		if (!response.ok) {
			throw new Error(
				`Policy bundle source returned HTTP ${response.status} ${response.statusText}`,
			);
		}
		return response.text();
	}

	const path = source.startsWith("file://") ? fileURLToPath(source) : source;
	return readFile(path, "utf8");
}

function resolvePolicyCachePath(path: string, cwd = process.cwd()): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function indexBy<T>(values: readonly T[], readKey: (value: T) => string): Map<string, T> {
	const indexed = new Map<string, T>();
	for (const value of values) {
		const key = readKey(value);
		if (!indexed.has(key)) {
			indexed.set(key, value);
		}
	}
	return indexed;
}

function duplicateIds(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			duplicates.add(value);
			continue;
		}
		seen.add(value);
	}
	return [...duplicates].sort();
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJsonValue);
	}

	if (!isRecord(value)) {
		return value;
	}

	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const item = value[key];
		if (item !== undefined) {
			sorted[key] = sortJsonValue(item);
		}
	}
	return sorted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
