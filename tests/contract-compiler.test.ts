import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { compileContractSource, diffContractSource } from "../src/contract/compiler.js";
import { validateContractSource } from "../src/contract/index.js";
import { initializePaveda } from "../src/init/index.js";

const tempDirs: string[] = [];
const profiles = ["fast", "standard", "strict", "release"] as const;
type JsonRecord = Record<string, unknown>;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("contract source compiler", () => {
	it("compiles YAML source into stable canonical JSON output", async () => {
		const dir = initProject("paveda-contract-compile-");
		await writeYamlSourceFromCompiledProject(dir);
		const first = compileContractSource({ cwd: dir, write: true });
		const compiledRelease = readFileSync(join(dir, ".paveda", "profiles", "release.json"), "utf8");
		const second = compileContractSource({ cwd: dir, write: true });

		expect(first.ok).toBe(true);
		expect(first.written).toBe(true);
		expect(first.outputs.map((output) => output.outputPath).sort()).toEqual(
			[
				".paveda/contract.json",
				".paveda/hosts/codex.json",
				".paveda/profiles/fast.json",
				".paveda/profiles/release.json",
				".paveda/profiles/standard.json",
				".paveda/profiles/strict.json",
			].sort(),
		);
		expect(second.ok).toBe(true);
		expect(second.compiledSha256).toBe(first.compiledSha256);
		expect(readFileSync(join(dir, ".paveda", "profiles", "release.json"), "utf8")).toBe(
			compiledRelease,
		);
		expect(diffContractSource({ cwd: dir }).ok).toBe(true);
		expect(validateContractSource({ cwd: dir, host: "codex", profile: "release" }).ok).toBe(true);
		const projectionIndex = readJson(join(dir, ".paveda", "projections", "index.json"));
		expect(projectionIndex.compiler).toMatchObject({
			sourceSha256: first.sourceSha256,
			compiledSha256: first.compiledSha256,
		});
	});

	it("reports invalid YAML as a source diagnostic", async () => {
		const dir = initProject("paveda-contract-invalid-yaml-");
		await writeYamlSourceFromCompiledProject(dir);
		writeFileSync(join(dir, ".paveda", "source", "contract.yaml"), "phaseGraph: [\n");

		const result = compileContractSource({ cwd: dir });

		expect(result.ok).toBe(false);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "source.yaml" })]),
		);
	});

	it("rejects unknown fields before emitting canonical JSON", async () => {
		const dir = initProject("paveda-contract-unknown-field-");
		await writeYamlSourceFromCompiledProject(dir, {
			mutateProfile(profile) {
				if (profile.profile === "strict") {
					return { ...profile, skippable: true };
				}
				return profile;
			},
		});

		const result = compileContractSource({ cwd: dir, write: true });

		expect(result.ok).toBe(false);
		expect(result.written).toBe(false);
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "schema.invalid" })]),
		);
	});

	it("reports semantic capability references and graph cycles", async () => {
		const capabilityDir = initProject("paveda-contract-broken-capability-");
		await writeYamlSourceFromCompiledProject(capabilityDir, {
			mutateProfile(profile) {
				if (profile.profile === "strict") {
					const gates = Array.isArray(profile.requiredGates)
						? profile.requiredGates.filter(isJsonRecord)
						: [];
					gates[0] = { ...(gates[0] ?? {}), capability: "test.magic" };
					return { ...profile, requiredGates: gates };
				}
				return profile;
			},
		});
		const capabilityResult = compileContractSource({ cwd: capabilityDir });
		expect(capabilityResult.ok).toBe(false);
		expect(capabilityResult.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "semantic.capability_reference" })]),
		);

		const cycleDir = initProject("paveda-contract-cycle-");
		await writeYamlSourceFromCompiledProject(cycleDir, {
			mutateContract(contract) {
				const phaseGraph = isJsonRecord(contract.phaseGraph) ? contract.phaseGraph : {};
				return {
					...contract,
					phaseGraph: {
						...phaseGraph,
						edges: [
							...(Array.isArray(phaseGraph.edges) ? phaseGraph.edges : []),
							{
								from: "handoff",
								to: "intake",
								condition: "invalid cycle",
								type: "normal",
								allowedProfiles: ["strict"],
								requiresEvidence: [],
								recordsDecision: false,
							},
						],
					},
				};
			},
		});
		const cycleResult = compileContractSource({ cwd: cycleDir });
		expect(cycleResult.ok).toBe(false);
		expect(cycleResult.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "semantic.phase_graph_cycle" })]),
		);
	});
});

function initProject(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	expect(existsSync(join(dir, ".paveda", "manifest.json"))).toBe(true);
	return dir;
}

async function writeYamlSourceFromCompiledProject(
	dir: string,
	options: {
		mutateContract?: (contract: JsonRecord) => JsonRecord;
		mutateProfile?: (profile: JsonRecord) => JsonRecord;
		mutateHost?: (host: JsonRecord) => JsonRecord;
	} = {},
): Promise<void> {
	const sourceRoot = join(dir, ".paveda", "source");
	await mkdir(join(sourceRoot, "profiles"), { recursive: true });
	await mkdir(join(sourceRoot, "hosts"), { recursive: true });
	const contract =
		options.mutateContract?.(readJson(join(dir, ".paveda", "contract.json"))) ??
		readJson(join(dir, ".paveda", "contract.json"));
	writeFileSync(join(sourceRoot, "contract.yaml"), stringify(contract));
	for (const profileName of profiles) {
		const profile = readJson(join(dir, ".paveda", "profiles", `${profileName}.json`));
		writeFileSync(
			join(sourceRoot, "profiles", `${profileName}.yaml`),
			stringify(options.mutateProfile?.(profile) ?? profile),
		);
	}
	const host = readJson(join(dir, ".paveda", "hosts", "codex.json"));
	writeFileSync(
		join(sourceRoot, "hosts", "codex.yaml"),
		stringify(options.mutateHost?.(host) ?? host),
	);
}

function readJson(path: string): JsonRecord {
	return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
