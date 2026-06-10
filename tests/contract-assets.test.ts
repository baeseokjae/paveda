import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

type EvidenceResult = "pass" | "fail" | "block" | "not_applicable" | "inconclusive";
type ProfileId = "fast" | "standard" | "strict" | "release";

type ResultPolicy = {
	acceptedResults: EvidenceResult[];
	blockingResults: EvidenceResult[];
	passRequiresDirectEvidence: boolean;
};

type RequiredEvidence = {
	id: string;
	kind: string;
	requiredForProfiles: ProfileId[];
	resultPolicy: ResultPolicy;
	providerCapability: string;
	notApplicableAllowed: boolean;
	notApplicableRationaleRequired: boolean;
};

type PhaseNode = {
	id: string;
	requiredCapabilities: string[];
	requiredEvidence: RequiredEvidence[];
};

type PhaseEdge = {
	from: string;
	to: string;
	type: string;
	requiresEvidence: string[];
	maxAttempts?: number;
};

type PhaseGraph = {
	entryPhase: string;
	terminalPhases: string[];
	happyPath: string[];
	repairEdges: string[];
	nodes: PhaseNode[];
	edges: PhaseEdge[];
};

type CapabilityDefinition = {
	id: string;
	evidenceKinds: string[];
};

type ScoreMetric = {
	id: string;
	calculation: {
		kind: string;
	};
	requiredEvidence: string[];
};

type RequiredGate = {
	id: string;
	phase: string;
	evidenceKind: string;
	requiredForTaskTypes: string[];
	capability: string;
	notApplicablePolicy: {
		allowed: boolean;
	};
	releaseOverrideAllowed: boolean;
};

type UniversalContract = {
	id: string;
	schemaVersion: string;
	contractVersion: string;
	minimumPavedaVersion: string;
	profiles: ProfileId[];
	phaseGraph: PhaseGraph;
	taskTypes: string[];
	scoreMetrics: ScoreMetric[];
	evidenceResults: EvidenceResult[];
	gates: RequiredGate[];
	capabilityRequirements: CapabilityDefinition[];
	projectionRules: {
		sourceRoots: string[];
		driftPolicy: string;
		allowedDriftResolutions: string[];
	};
};

type ScoreThreshold = {
	metric: string;
	pass: number;
	warn: number;
	block: number;
	repairTrigger: number;
	overrideAllowed: boolean;
};

type ProfileManifest = {
	profile: ProfileId;
	schemaVersion: string;
	contractVersion: string;
	minimumPavedaVersion: string;
	extends: ProfileId | null;
	scoreThresholds: ScoreThreshold[];
	requiredGates: RequiredGate[];
	verificationLadder: string[];
	notApplicablePolicy: {
		allowedTaskTypes: string[];
		ambiguousBehavior: string;
	};
	releaseSupport: {
		status: "supported" | "not_supported_in_mvp";
		suggestedProfile: ProfileId;
		unimplementedGates: string[];
		blockMessage?: string;
	};
};

type HostCapabilityEntry = {
	id: string;
	support: string;
	confidence: number;
	source: string;
};

type HostDeclaration = {
	host: string;
	schemaVersion: string;
	declarationVersion: string;
	minimumPavedaVersion: string;
	supportLevel: "deep" | "shallow";
	capabilities: HostCapabilityEntry[];
	unsupportedCapabilities: string[];
	conformanceFixtures: string[];
};

type JsonRecord = Record<string, unknown>;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const harnessRoot = join(repoRoot, "assets", "harness");
const contractRoot = join(harnessRoot, "contracts");
const profilesRoot = join(contractRoot, "profiles");
const hostsRoot = join(harnessRoot, "hosts");
const schemasRoot = join(contractRoot, "schemas");

const expectedContractAssets = [
	"contracts/universal-contract.v1.json",
	"contracts/profiles/fast.json",
	"contracts/profiles/standard.json",
	"contracts/profiles/strict.json",
	"contracts/profiles/release.json",
	"contracts/schemas/contract.schema.json",
	"contracts/schemas/capabilities.schema.json",
	"hosts/claude-code.json",
	"hosts/codex.json",
	"hosts/pi.json",
	"hosts/hermes.json",
];

const contract = readJson<UniversalContract>(join(contractRoot, "universal-contract.v1.json"));
const profileManifests = readJsonDirectory<ProfileManifest>(profilesRoot);
const hostDeclarations = readJsonDirectory<HostDeclaration>(hostsRoot);
const contractSchema = readJson<JsonRecord>(join(schemasRoot, "contract.schema.json"));
const capabilitiesSchema = readJson<JsonRecord>(join(schemasRoot, "capabilities.schema.json"));

const ajv = new Ajv({
	allErrors: true,
	allowUnionTypes: true,
	strict: true,
});
ajv.addSchema(capabilitiesSchema);
ajv.addSchema(contractSchema);

const validateUniversalContract = requiredSchema(
	"https://paveda.dev/schemas/contract.schema.json#/$defs/universalContract",
);
const validateProfileManifest = requiredSchema(
	"https://paveda.dev/schemas/contract.schema.json#/$defs/profileManifest",
);
const validateHostDeclaration = requiredSchema(
	"https://paveda.dev/schemas/contract.schema.json#/$defs/hostDeclaration",
);
const validateCapabilityDefinition = requiredSchema(
	"https://paveda.dev/schemas/capabilities.schema.json#/$defs/capabilityDefinition",
);
const validateHostCapabilityEntry = requiredSchema(
	"https://paveda.dev/schemas/capabilities.schema.json#/$defs/hostCapabilityEntry",
);

describe("contract assets", () => {
	it("ships the PR 1 contract, profile, schema, and host declaration assets", () => {
		const missing = expectedContractAssets.filter((path) => !existsSync(join(harnessRoot, path)));

		expect(missing).toEqual([]);
	});

	it("validates every machine manifest with AJV", () => {
		expectValid(validateUniversalContract, contract);

		for (const capability of contract.capabilityRequirements) {
			expectValid(validateCapabilityDefinition, capability);
		}

		for (const profile of profileManifests) {
			expectValid(validateProfileManifest, profile);
		}

		for (const host of hostDeclarations) {
			expectValid(validateHostDeclaration, host);
			for (const capability of host.capabilities) {
				expectValid(validateHostCapabilityEntry, capability);
			}
		}
	});

	it("rejects unknown fields instead of allowing policy drift through typos", () => {
		const contractWithUnknownField = clone(contract) as UniversalContract & {
			accidentalPolicy?: boolean;
		};
		contractWithUnknownField.accidentalPolicy = true;
		expectInvalid(validateUniversalContract, contractWithUnknownField, "additionalProperties");

		const strictProfile = clone(profileById("strict"));
		(strictProfile.requiredGates[0] as RequiredGate & { skippable?: boolean }).skippable = true;
		expectInvalid(validateProfileManifest, strictProfile, "additionalProperties");

		const codexHost = clone(hostById("codex"));
		(codexHost.capabilities[0] as HostCapabilityEntry & { guessed?: boolean }).guessed = true;
		expectInvalid(validateHostDeclaration, codexHost, "additionalProperties");
	});

	it("requires manifest version fields and blocks unknown major versions semantically", () => {
		for (const manifest of [contract, ...profileManifests, ...hostDeclarations]) {
			expect(manifest.schemaVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
			expect(manifest.minimumPavedaVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
			expect(knownMajor(manifest.schemaVersion)).toBe(true);
		}

		const invalid = clone(contract);
		invalid.schemaVersion = "next";
		expectInvalid(validateUniversalContract, invalid, "pattern");
		expect(knownMajor("2.0.0")).toBe(false);
	});

	it("requires profile and host declaration fields", () => {
		const profile = withoutProperty(clone(profileById("strict")), "requiredGates");
		expectInvalid(validateProfileManifest, profile, "required");

		const host = withoutProperty(clone(hostById("claude-code")), "capabilities");
		expectInvalid(validateHostDeclaration, host, "required");
	});

	it("defines an acyclic phase graph with a connected linear happy path", () => {
		expect(validatePhaseGraph(contract.phaseGraph)).toEqual([]);

		const cyclic = clone(contract);
		cyclic.phaseGraph.edges.push({
			from: "handoff",
			to: "intake",
			condition: "invalid cycle",
			type: "normal",
			allowedProfiles: ["strict"],
			requiresEvidence: [],
			recordsDecision: true,
		} as PhaseEdge & {
			condition: string;
			allowedProfiles: string[];
			recordsDecision: boolean;
		});

		expect(validatePhaseGraph(cyclic.phaseGraph)).toContain("phase graph must be acyclic");
	});

	it("enforces phase node and repair edge shape", () => {
		const missingNodeField = clone(contract);
		missingNodeField.phaseGraph.nodes[0] = withoutProperty(
			missingNodeField.phaseGraph.nodes[0],
			"id",
		) as PhaseNode;
		expectInvalid(validateUniversalContract, missingNodeField, "required");

		const missingRepairAttempts = clone(contract);
		const repairEdgeIndex = missingRepairAttempts.phaseGraph.edges.findIndex(
			(edge) => edge.type === "repair",
		);
		expect(repairEdgeIndex).toBeGreaterThanOrEqual(0);
		missingRepairAttempts.phaseGraph.edges[repairEdgeIndex] = withoutProperty(
			missingRepairAttempts.phaseGraph.edges[repairEdgeIndex],
			"maxAttempts",
		) as PhaseEdge;
		expectInvalid(validateUniversalContract, missingRepairAttempts, "required");

		const invalidEdgeType = clone(contract);
		invalidEdgeType.phaseGraph.edges[0].type = "retry";
		expectInvalid(validateUniversalContract, invalidEdgeType, "enum");
	});

	it("keeps evidence results, evidence kind enums, and not-applicable policy strict", () => {
		expect(contract.evidenceResults).toEqual([
			"pass",
			"fail",
			"block",
			"not_applicable",
			"inconclusive",
		]);
		expect(contract.evidenceResults).not.toContain("skip");

		const invalidEvidenceKind = clone(contract);
		firstEvidence(invalidEvidenceKind).kind = "magic_review";
		expectInvalid(validateUniversalContract, invalidEvidenceKind, "enum");

		const invalidNotApplicable = clone(contract);
		const evidence = firstEvidence(invalidNotApplicable);
		evidence.notApplicableAllowed = true;
		evidence.notApplicableRationaleRequired = false;
		expectInvalid(validateUniversalContract, invalidNotApplicable, "const");
	});

	it("requires direct pass evidence for strict profile evidence except terminal block records", () => {
		const strictEvidence = allRequiredEvidence(contract).filter((evidence) =>
			evidence.requiredForProfiles.includes("strict"),
		);
		const nonPassStrictEvidence = strictEvidence
			.filter((evidence) => evidence.id !== "block-record")
			.filter((evidence) => evidence.resultPolicy.acceptedResults.join(",") !== "pass")
			.map((evidence) => evidence.id);
		const indirectStrictEvidence = strictEvidence
			.filter((evidence) => evidence.id !== "block-record")
			.filter((evidence) => !("passRequiresDirectEvidence" in evidence.resultPolicy))
			.map((evidence) => evidence.id);

		expect(nonPassStrictEvidence).toEqual([]);
		expect(indirectStrictEvidence).toEqual([]);
	});

	it("resolves every capability reference from contract, profiles, and host declarations", () => {
		expect(validateCapabilityReferences(contract, profileManifests, hostDeclarations)).toEqual([]);

		const invalid = clone(contract);
		invalid.gates[0].capability = "test.magic";
		expect(validateCapabilityReferences(invalid, profileManifests, hostDeclarations)).toContain(
			"gate unit-gate references unknown capability test.magic",
		);
	});

	it("keeps score metrics, profile thresholds, and score calculation kinds explicit", () => {
		const expectedMetrics = [
			"ambiguity_score",
			"plan_quality_score",
			"progress_score",
			"match_score",
			"verification_score",
			"risk_score",
		];

		expect(contract.scoreMetrics.map((metric) => metric.id).sort()).toEqual(
			[...expectedMetrics].sort(),
		);
		for (const profile of profileManifests) {
			expect(profile.scoreThresholds.map((threshold) => threshold.metric).sort()).toEqual(
				[...expectedMetrics].sort(),
			);
		}

		const strict = profileById("strict");
		expect(thresholdByMetric(strict, "ambiguity_score")).toMatchObject({
			pass: 0.15,
			block: 0.2,
			overrideAllowed: false,
		});
		expect(thresholdByMetric(strict, "match_score")).toMatchObject({
			pass: 0.95,
			overrideAllowed: false,
		});
		expect(thresholdByMetric(strict, "verification_score")).toMatchObject({
			pass: 1,
			overrideAllowed: false,
		});
		expect(thresholdByMetric(strict, "risk_score")).toMatchObject({
			pass: 0.2,
			block: 0.3,
			overrideAllowed: false,
		});

		const invalidCalculation = clone(contract);
		invalidCalculation.scoreMetrics[0].calculation.kind = "javascript_expression";
		expectInvalid(validateUniversalContract, invalidCalculation, "enum");
	});

	it("keeps strict and release gates blocking for code-changing work", () => {
		const strict = profileById("strict");
		const strictGateIds = strict.requiredGates.map((gate) => gate.id).sort();
		expect(strictGateIds).toEqual(
			[
				"build-gate",
				"coverage-gate",
				"e2e-gate",
				"lint-gate",
				"risk-gate",
				"semantic-gate",
				"typecheck-gate",
				"unit-gate",
			].sort(),
		);
		expect(gateById(strict, "unit-gate").notApplicablePolicy.allowed).toBe(true);
		expect(gateById(strict, "unit-gate").missingCapabilityBehavior).toBe("ask_setup_sprint");
		expect(gateById(strict, "e2e-gate").missingCapabilityBehavior).toBe("ask_setup_sprint");
		expect(gateById(strict, "e2e-gate").requiredForTaskTypes).toContain("code");
		expect(gateById(strict, "unit-gate").requiredForTaskTypes).toEqual(
			expect.arrayContaining(["docs", "metadata"]),
		);
		expect(gateById(strict, "e2e-gate").requiredForTaskTypes).toEqual(
			expect.arrayContaining(["docs", "metadata"]),
		);

		const release = profileById("release");
		const releaseGateIds = release.requiredGates.map((gate) => gate.id).sort();
		expect(releaseGateIds).toEqual(
			[
				"adversarial-gate",
				"coverage-gate",
				"e2e-gate",
				"full-conformance",
				"immutable-artifact-retention",
				"release-signoff",
				"risk-gate",
				"security-gate",
				"semantic-gate",
				"unit-gate",
			].sort(),
		);
		expect(gateById(release, "e2e-gate").requiredForTaskTypes).toContain("code");
		expect(gateById(release, "release-signoff").evidenceKind).toBe("manual_decision");
		expect(gateById(release, "full-conformance").evidenceKind).toBe("host_event");
		expect(gateById(release, "immutable-artifact-retention").evidenceKind).toBe("trace");
		expect(release.requiredGates.every((gate) => gate.releaseOverrideAllowed === false)).toBe(true);
		expect(release.requiredGates.every((gate) => gate.failureBehavior === "block")).toBe(true);
	});

	it("declares release as supported with all release gates implemented", () => {
		const release = profileById("release");

		expect(release.releaseSupport.status).toBe("supported");
		expect(release.releaseSupport.suggestedProfile).toBe("strict");
		expect(release.releaseSupport.unimplementedGates).toEqual([]);
		expect(release.requiredGates.map((gate) => gate.id)).toEqual(
			expect.arrayContaining([
				"release-signoff",
				"full-conformance",
				"immutable-artifact-retention",
			]),
		);
	});

	it("declares host support levels and deep lifecycle unsupported capabilities", () => {
		expect(hostById("claude-code").supportLevel).toBe("deep");
		expect(hostById("codex").supportLevel).toBe("deep");
		expect(hostById("pi").supportLevel).toBe("deep");
		expect(hostById("hermes").supportLevel).toBe("deep");
		expect(hostById("codex").conformanceFixtures).toEqual(
			expect.arrayContaining([
				"codex-goal-lifecycle-handoff",
				"codex-native-goal-status-mapping",
				"release-missing-gates-blocks",
				"release-full-evidence-passes",
			]),
		);
		expect(hostById("pi").conformanceFixtures).toEqual(
			expect.arrayContaining([
				"pi-hook-lifecycle-capture",
				"pi-command-evidence",
				"release-missing-gates-blocks",
				"release-full-evidence-passes",
			]),
		);
		expect(hostById("hermes").conformanceFixtures).toEqual(
			expect.arrayContaining([
				"hermes-hook-lifecycle-capture",
				"hermes-command-evidence",
				"release-missing-gates-blocks",
				"release-full-evidence-passes",
			]),
		);

		for (const host of [hostById("pi"), hostById("hermes")]) {
			expect(host.unsupportedCapabilities).toContain("goal.native");
			expect(host.unsupportedCapabilities).toContain("workflow.native");
			expect(host.unsupportedCapabilities).not.toContain("hook.lifecycle");
			expect(host.unsupportedCapabilities).toContain("semantic.review");
		}
	});
});

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonDirectory<T>(path: string): T[] {
	return readdirSync(path)
		.filter((entry) => entry.endsWith(".json"))
		.sort()
		.map((entry) => readJson<T>(join(path, entry)));
}

function requiredSchema(id: string): ValidateFunction {
	const schema = ajv.getSchema(id);
	if (!schema) {
		throw new Error(`missing schema: ${id}`);
	}
	return schema;
}

function expectValid(validate: ValidateFunction, value: unknown): void {
	const valid = validate(value);
	expect(formatErrors(validate)).toEqual([]);
	expect(valid).toBe(true);
}

function expectInvalid(validate: ValidateFunction, value: unknown, keyword: string): void {
	const valid = validate(value);
	expect(valid).toBe(false);
	expect(validate.errors?.some((error) => error.keyword === keyword)).toBe(true);
}

function formatErrors(validate: ValidateFunction): string[] {
	return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

function profileById(profile: ProfileId): ProfileManifest {
	const manifest = profileManifests.find((candidate) => candidate.profile === profile);
	if (!manifest) {
		throw new Error(`missing profile: ${profile}`);
	}
	return manifest;
}

function hostById(host: string): HostDeclaration {
	const declaration = hostDeclarations.find((candidate) => candidate.host === host);
	if (!declaration) {
		throw new Error(`missing host: ${host}`);
	}
	return declaration;
}

function thresholdByMetric(profile: ProfileManifest, metric: string): ScoreThreshold {
	const threshold = profile.scoreThresholds.find((candidate) => candidate.metric === metric);
	if (!threshold) {
		throw new Error(`missing threshold: ${profile.profile}/${metric}`);
	}
	return threshold;
}

function gateById(profile: ProfileManifest, id: string): RequiredGate {
	const gate = profile.requiredGates.find((candidate) => candidate.id === id);
	if (!gate) {
		throw new Error(`missing gate: ${profile.profile}/${id}`);
	}
	return gate;
}

function firstEvidence(value: UniversalContract): RequiredEvidence {
	const evidence = allRequiredEvidence(value)[0];
	if (!evidence) {
		throw new Error("missing required evidence");
	}
	return evidence;
}

function allRequiredEvidence(value: UniversalContract): RequiredEvidence[] {
	return value.phaseGraph.nodes.flatMap((node) => node.requiredEvidence);
}

function knownMajor(version: string): boolean {
	return Number(version.split(".")[0]) === 1;
}

function validatePhaseGraph(graph: PhaseGraph): string[] {
	const errors: string[] = [];
	const nodeIds = new Set(graph.nodes.map((node) => node.id));
	if (!nodeIds.has(graph.entryPhase)) {
		errors.push(`entry phase ${graph.entryPhase} is missing`);
	}
	for (const terminal of graph.terminalPhases) {
		if (!nodeIds.has(terminal)) {
			errors.push(`terminal phase ${terminal} is missing`);
		}
	}
	for (const phase of graph.happyPath) {
		if (!nodeIds.has(phase)) {
			errors.push(`happy path phase ${phase} is missing`);
		}
	}
	for (const edge of graph.edges) {
		if (!nodeIds.has(edge.from)) {
			errors.push(`edge references missing source ${edge.from}`);
		}
		if (!nodeIds.has(edge.to)) {
			errors.push(`edge references missing target ${edge.to}`);
		}
	}
	for (const [from, to] of pairwise(graph.happyPath)) {
		if (!graph.edges.some((edge) => edge.from === from && edge.to === to)) {
			errors.push(`happy path is missing ${from} -> ${to}`);
		}
	}
	if (hasCycle(graph)) {
		errors.push("phase graph must be acyclic");
	}
	return errors;
}

function validateCapabilityReferences(
	value: UniversalContract,
	profiles: ProfileManifest[],
	hosts: HostDeclaration[],
): string[] {
	const errors: string[] = [];
	const capabilities = new Set(value.capabilityRequirements.map((capability) => capability.id));

	for (const node of value.phaseGraph.nodes) {
		for (const capability of node.requiredCapabilities) {
			if (!capabilities.has(capability)) {
				errors.push(`phase ${node.id} references unknown capability ${capability}`);
			}
		}
		for (const evidence of node.requiredEvidence) {
			if (!capabilities.has(evidence.providerCapability)) {
				errors.push(
					`evidence ${evidence.id} references unknown capability ${evidence.providerCapability}`,
				);
			}
		}
	}
	for (const gate of value.gates) {
		if (!capabilities.has(gate.capability)) {
			errors.push(`gate ${gate.id} references unknown capability ${gate.capability}`);
		}
	}
	for (const profile of profiles) {
		for (const gate of profile.requiredGates) {
			if (!capabilities.has(gate.capability)) {
				errors.push(
					`profile ${profile.profile} gate ${gate.id} references unknown capability ${gate.capability}`,
				);
			}
		}
	}
	for (const host of hosts) {
		for (const capability of host.capabilities) {
			if (!capabilities.has(capability.id)) {
				errors.push(`host ${host.host} references unknown capability ${capability.id}`);
			}
		}
		for (const capability of host.unsupportedCapabilities) {
			if (!capabilities.has(capability)) {
				errors.push(`host ${host.host} rejects unknown capability ${capability}`);
			}
		}
	}
	return errors;
}

function hasCycle(graph: PhaseGraph): boolean {
	const adjacency = new Map<string, string[]>();
	for (const node of graph.nodes) {
		adjacency.set(node.id, []);
	}
	for (const edge of graph.edges) {
		adjacency.get(edge.from)?.push(edge.to);
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	function visit(node: string): boolean {
		if (visiting.has(node)) {
			return true;
		}
		if (visited.has(node)) {
			return false;
		}
		visiting.add(node);
		for (const next of adjacency.get(node) ?? []) {
			if (visit(next)) {
				return true;
			}
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	}

	return [...adjacency.keys()].some((node) => visit(node));
}

function pairwise(values: string[]): Array<[string, string]> {
	const pairs: Array<[string, string]> = [];
	for (let index = 0; index < values.length - 1; index += 1) {
		const from = values[index];
		const to = values[index + 1];
		if (from && to) {
			pairs.push([from, to]);
		}
	}
	return pairs;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function withoutProperty<T extends JsonRecord, K extends keyof T>(value: T, key: K): Omit<T, K> {
	return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key)) as Omit<
		T,
		K
	>;
}
