import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePaveda } from "../src/init/index.js";
import { buildPack, inspectPack, installPack, verifyPack } from "../src/pack/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("shared pack packaging", () => {
	it("builds deterministic contract packs and verifies their checksums", () => {
		const project = initProject("paveda-pack-build-");
		writeFileSync(
			join(project, ".paveda", "evidence-policy.json"),
			`${JSON.stringify({ schemaVersion: 1, providers: [] }, null, 2)}\n`,
		);
		const outA = join(project, "pack-a.tgz");
		const outB = join(project, "pack-b.tgz");

		const builtA = buildPack({ cwd: project, out: outA });
		const builtB = buildPack({ cwd: project, out: outB });
		const inspected = inspectPack({ path: outA });
		const verified = verifyPack({ path: outA });

		expect(readFileSync(outA)).toEqual(readFileSync(outB));
		expect(builtA.manifest.entries.map((entry) => entry.path)).toEqual(
			builtB.manifest.entries.map((entry) => entry.path),
		);
		expect(inspected.ok).toBe(true);
		expect(verified).toMatchObject({
			ok: true,
			errors: [],
		});
		expect(builtA.manifest.entries.map((entry) => entry.path)).toEqual(
			expect.arrayContaining([
				"contracts/contract.json",
				"contracts/profiles/strict.json",
				"hosts/codex.json",
				"evidence-providers/evidence-policy.json",
			]),
		);
	});

	it("reports install diff before writing pack files", () => {
		const source = initProject("paveda-pack-source-");
		const target = tempDir("paveda-pack-target-");
		const out = join(source, "pack.tgz");
		buildPack({ cwd: source, out });

		const dryRun = installPack({ path: out, cwd: target });
		expect(dryRun).toMatchObject({
			ok: true,
			dryRun: true,
		});
		expect(dryRun.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					packPath: "contracts/contract.json",
					projectPath: join(target, ".paveda", "contract.json"),
					action: "create",
				}),
			]),
		);
		expect(existsSync(join(target, ".paveda", "contract.json"))).toBe(false);

		const written = installPack({ path: out, cwd: target, write: true });
		expect(written.ok).toBe(true);
		expect(existsSync(join(target, ".paveda", "contract.json"))).toBe(true);

		writeFileSync(join(target, ".paveda", "contract.json"), '{"drift":true}\n');
		const updateDiff = installPack({ path: out, cwd: target });
		expect(updateDiff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					packPath: "contracts/contract.json",
					action: "update",
				}),
			]),
		);
	});

	it("verifies permissioned pack policy metadata", () => {
		const project = initProject("paveda-pack-policy-");
		writeFileSync(
			join(project, ".paveda", "pack-policy.json"),
			`${JSON.stringify(
				{
					capabilities: ["read", "shell", "mcp"],
					riskSurfaces: ["auth"],
					requiredEvidence: ["security_scan"],
					requiredProfiles: ["strict", "release"],
					publisher: "example",
					signature: {
						keyId: "example-key",
						algorithm: "ed25519",
					},
				},
				null,
				2,
			)}\n`,
		);
		const out = join(project, "permissioned.tgz");

		const built = buildPack({ cwd: project, out });
		const inspected = inspectPack({ path: out });
		const installed = installPack({
			path: out,
			cwd: tempDir("paveda-pack-policy-target-"),
			host: "codex",
		});

		expect(built.manifest).toMatchObject({
			capabilities: ["read", "shell", "mcp"],
			riskSurfaces: ["auth"],
			requiredEvidence: ["security_scan"],
			requiredProfiles: ["strict", "release"],
			publisher: "example",
			signature: {
				keyId: "example-key",
				algorithm: "ed25519",
			},
		});
		expect(inspected).toMatchObject({
			ok: true,
			permissions: {
				capabilities: ["read", "shell", "mcp"],
				riskSurfaces: ["auth"],
				requiredEvidence: ["security_scan"],
				requiredProfiles: ["strict", "release"],
				publisher: "example",
				signed: true,
			},
		});
		expect(installed.permissions).toMatchObject({
			capabilities: ["read", "shell", "mcp"],
			signed: true,
		});
		expect(verifyPack({ path: out }).warnings).toEqual([
			"pack host compatibility was not checked; pass --host to verify target support",
		]);
		expect(verifyPack({ path: out, host: "codex" })).toMatchObject({
			ok: true,
			hostCompatibility: {
				host: "codex",
				requiredCapabilities: ["read", "shell", "mcp"],
				unsupportedCapabilities: [],
			},
		});
	});

	it("blocks pack verify and install when target host lacks required capabilities", () => {
		const packPath = buildPolicyPack("paveda-pack-host-capability-", {
			capabilities: ["read", "mcp"],
		});
		const target = tempDir("paveda-pack-host-target-");

		expect(verifyPack({ path: packPath, host: "harness" })).toMatchObject({
			ok: false,
			errors: expect.arrayContaining(["unsupported pack capability for host harness: mcp"]),
			hostCompatibility: {
				host: "harness",
				requiredCapabilities: ["read", "mcp"],
				unsupportedCapabilities: expect.arrayContaining(["mcp"]),
			},
		});
		expect(installPack({ path: packPath, cwd: target, host: "harness" })).toMatchObject({
			ok: false,
			errors: expect.arrayContaining(["unsupported pack capability for host harness: mcp"]),
			hostCompatibility: {
				host: "harness",
				unsupportedCapabilities: expect.arrayContaining(["mcp"]),
			},
		});
		expect(existsSync(join(target, ".paveda", "contract.json"))).toBe(false);
	});

	it("rejects unsafe permissioned pack policies", () => {
		const unknownCapability = buildPolicyPack("paveda-pack-unknown-cap-", {
			capabilities: ["root"],
		});
		const missingEvidence = buildPolicyPack("paveda-pack-risk-no-evidence-", {
			capabilities: ["read"],
			riskSurfaces: ["auth"],
			requiredEvidence: ["unit_test"],
		});
		const unsignedRelease = buildPolicyPack("paveda-pack-unsigned-release-", {
			capabilities: ["read"],
			requiredProfiles: ["release"],
		});

		expect(verifyPack({ path: unknownCapability }).errors).toContain(
			"unknown pack capability: root",
		);
		expect(verifyPack({ path: missingEvidence }).errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("high-risk pack surfaces require security_scan or risk_review"),
			]),
		);
		expect(
			installPack({ path: unsignedRelease, cwd: tempDir("paveda-pack-unsafe-target-") }),
		).toMatchObject({
			ok: false,
			errors: expect.arrayContaining(["release pack policy requires signature metadata"]),
		});
	});

	it("rejects packs that lower baseline profile thresholds", () => {
		const project = initProject("paveda-pack-threshold-");
		const strictPath = join(project, ".paveda", "profiles", "strict.json");
		const strict = JSON.parse(readFileSync(strictPath, "utf8")) as {
			scoreThresholds: Array<{ metric: string; pass: number }>;
		};
		const threshold = strict.scoreThresholds.find(
			(candidate) => candidate.metric === "verification_score",
		);
		if (!threshold) {
			throw new Error("strict profile fixture missing verification_score threshold");
		}
		threshold.pass = 0.5;
		writeFileSync(strictPath, `${JSON.stringify(strict, null, 2)}\n`);
		const out = join(project, "threshold.tgz");
		buildPack({ cwd: project, out });

		expect(verifyPack({ path: out }).errors).toContain(
			"profile threshold lowered: strict.json:verification_score",
		);
	});
});

function initProject(prefix: string): string {
	const dir = tempDir(prefix);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	return dir;
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function buildPolicyPack(prefix: string, policy: Record<string, unknown>): string {
	const project = initProject(prefix);
	writeFileSync(
		join(project, ".paveda", "pack-policy.json"),
		`${JSON.stringify(policy, null, 2)}\n`,
	);
	const out = join(project, "policy.tgz");
	buildPack({ cwd: project, out });
	return out;
}
