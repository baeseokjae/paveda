import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	canonicalPolicyJson,
	comparePolicyBundleToRuntime,
	createPolicyBundle,
	createPolicyBundleArtifact,
	createPolicyBundleCacheEntry,
	digestPolicyBundle,
	fetchSignedPolicyBundle,
	signPolicyBundle,
	verifySignedPolicyBundle,
	verifySignedPolicyBundleWithKeyring,
} from "../src/policy/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("policy bundle", () => {
	it("creates deterministic bundle artifacts from runtime rules and host capabilities", () => {
		const bundle = createPolicyBundle({
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
			version: "0.1.0-test",
		});
		const artifact = createPolicyBundleArtifact(bundle);

		expect(bundle).toMatchObject({
			schemaVersion: 1,
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
			policyRuntime: {
				name: "paveda",
				version: "0.1.0-test",
			},
		});
		expect(bundle.rules.map((rule) => rule.id)).toContain("workflow.verification.handoff-gate");
		expect(bundle.hostCapabilities.map((capability) => capability.host)).toEqual([
			"claude-code",
			"codex",
			"hermes",
			"mcp",
			"pi",
		]);
		expect(artifact.canonicalSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(artifact.canonicalSha256).toBe(digestPolicyBundle(bundle));
		expect(canonicalPolicyJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
	});

	it("signs and verifies a policy bundle with an Ed25519 key pair", () => {
		const { privateKeyPem, publicKeyPem } = generateEd25519PemPair();
		const bundle = createPolicyBundle({
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		});
		const signed = signPolicyBundle(bundle, {
			privateKeyPem,
			keyId: "test-key-1",
		});

		expect(signed.signature).toMatchObject({
			algorithm: "ed25519",
			keyId: "test-key-1",
		});
		expect(
			verifySignedPolicyBundle(signed, {
				publicKeyPem,
			}),
		).toEqual({
			ok: true,
			expectedSha256: signed.canonicalSha256,
			actualSha256: signed.canonicalSha256,
			keyId: "test-key-1",
		});
	});

	it("detects digest and signature drift", () => {
		const { privateKeyPem, publicKeyPem } = generateEd25519PemPair();
		const bundle = createPolicyBundle({
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		});
		const signed = signPolicyBundle(bundle, {
			privateKeyPem,
			keyId: "test-key-1",
		});
		const tamperedBundle = {
			...signed,
			bundle: {
				...signed.bundle,
				issuer: "tampered",
			},
		};

		expect(verifySignedPolicyBundle(tamperedBundle, { publicKeyPem })).toMatchObject({
			ok: false,
			reason: "digest_mismatch",
			keyId: "test-key-1",
		});

		expect(
			verifySignedPolicyBundle(
				{
					...tamperedBundle,
					canonicalSha256: digestPolicyBundle(tamperedBundle.bundle),
				},
				{ publicKeyPem },
			),
		).toMatchObject({
			ok: false,
			reason: "invalid_signature",
			keyId: "test-key-1",
		});
	});

	it("verifies signed bundles through a rotating trusted keyring", () => {
		const oldKey = generateEd25519PemPair();
		const activeKey = generateEd25519PemPair();
		const bundle = createPolicyBundle({
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		});
		const signed = signPolicyBundle(bundle, {
			privateKeyPem: activeKey.privateKeyPem,
			keyId: "active-key",
		});

		expect(
			verifySignedPolicyBundleWithKeyring(signed, {
				keys: [
					{ keyId: "old-key", publicKeyPem: oldKey.publicKeyPem },
					{ keyId: "active-key", publicKeyPem: activeKey.publicKeyPem },
				],
			}),
		).toMatchObject({
			ok: true,
			keyId: "active-key",
		});
		expect(
			verifySignedPolicyBundleWithKeyring(signed, {
				keys: [{ publicKeyPem: activeKey.publicKeyPem }],
			}),
		).toMatchObject({
			ok: true,
			keyId: "active-key",
		});

		expect(
			verifySignedPolicyBundleWithKeyring(signed, {
				keys: [{ keyId: "old-key", publicKeyPem: oldKey.publicKeyPem }],
			}),
		).toMatchObject({
			ok: false,
			keyId: "active-key",
			reason: "key_not_found",
		});

		const unsignedKeyIdBundle = signPolicyBundle(bundle, {
			privateKeyPem: activeKey.privateKeyPem,
		});
		expect(
			verifySignedPolicyBundleWithKeyring(unsignedKeyIdBundle, {
				keys: [
					{ keyId: "old-key", publicKeyPem: oldKey.publicKeyPem },
					{ keyId: "active-key", publicKeyPem: activeKey.publicKeyPem },
				],
			}),
		).toMatchObject({
			ok: true,
			keyId: "active-key",
		});
	});

	it("fetches a signed bundle from a source and builds a cache entry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-policy-bundle-"));
		tempDirs.push(dir);
		const { privateKeyPem, publicKeyPem } = generateEd25519PemPair();
		const signed = signPolicyBundle(
			createPolicyBundle({
				issuer: "control-plane-test",
				generatedAt: "2026-06-01T00:00:00.000Z",
			}),
			{ privateKeyPem, keyId: "source-key" },
		);
		const sourcePath = join(dir, "policy.signed.json");
		writeFileSync(sourcePath, `${JSON.stringify(signed, null, 2)}\n`);

		await expect(fetchSignedPolicyBundle(sourcePath)).resolves.toEqual(signed);
		const fetched = await fetchSignedPolicyBundle(pathToFileURL(sourcePath).toString());
		const verification = verifySignedPolicyBundleWithKeyring(fetched, {
			keys: [{ keyId: "source-key", publicKeyPem }],
		});
		const cacheEntry = createPolicyBundleCacheEntry(fetched, verification, {
			source: sourcePath,
			cachedAt: "2026-06-01T00:01:00.000Z",
		});

		expect(cacheEntry).toMatchObject({
			schemaVersion: 1,
			cachedAt: "2026-06-01T00:01:00.000Z",
			source: sourcePath,
			summary: {
				issuer: "control-plane-test",
				keyId: "source-key",
				canonicalSha256: signed.canonicalSha256,
			},
			verification: {
				ok: true,
				keyId: "source-key",
			},
			signedBundle: signed,
		});
	});

	it("compares signed bundle metadata with the local runtime rule set", () => {
		const bundle = createPolicyBundle({
			issuer: "control-plane-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		});

		expect(comparePolicyBundleToRuntime(bundle)).toMatchObject({
			ok: true,
			runtimeVersionMatches: true,
			missingRuleIds: [],
			extraRuleIds: [],
			changedRules: [],
			missingHostIds: [],
			extraHostIds: [],
			changedHostCapabilities: [],
		});

		const drifted = {
			...bundle,
			policyRuntime: { ...bundle.policyRuntime, version: "0.0.0-older" },
			rules: [
				...bundle.rules.slice(1),
				{ id: "control-plane.extra-rule", description: "Unexpected remote rule." },
			],
			hostCapabilities: bundle.hostCapabilities.map((capability) =>
				capability.host === "codex"
					? { ...capability, nativeToolBypassRisk: "high" as const }
					: capability,
			),
		};

		expect(comparePolicyBundleToRuntime(drifted)).toMatchObject({
			ok: false,
			runtimeVersionMatches: false,
			bundleRuntimeVersion: "0.0.0-older",
			missingRuleIds: [bundle.rules[0]?.id],
			extraRuleIds: ["control-plane.extra-rule"],
			changedHostCapabilities: [
				expect.objectContaining({
					host: "codex",
					bundleCapability: expect.objectContaining({ nativeToolBypassRisk: "high" }),
					localCapability: expect.objectContaining({ nativeToolBypassRisk: "medium" }),
				}),
			],
		});
	});
});

function generateEd25519PemPair(): { privateKeyPem: string; publicKeyPem: string } {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
		publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
	};
}
