import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import type { HostSkillBundleTarget } from "../host-bundles/index.js";
import { parseHostSkillBundleTarget } from "../host-bundles/index.js";
import type { PavedaProfile } from "../store/index.js";

export type ContractCheckStatus = "pass" | "fail" | "warn" | "not_applicable";

export interface ContractValidationOptions {
	cwd?: string;
	host?: HostSkillBundleTarget | string;
	profile?: PavedaProfile | string;
	includeProjection?: boolean;
}

export interface ContractValidationCheck {
	name: string;
	status: ContractCheckStatus;
	message: string;
	path?: string;
	errors?: string[];
}

export interface ContractValidationResult {
	cwd: string;
	host?: HostSkillBundleTarget;
	profile: PavedaProfile;
	ok: boolean;
	checks: ContractValidationCheck[];
}

export interface ContractExplainOptions {
	cwd?: string;
	profile?: PavedaProfile | string;
}

export interface ContractExplainResult {
	cwd: string;
	profile: PavedaProfile;
	releaseSupport: unknown;
	requiredGates: unknown[];
	scoreThresholds: unknown[];
	verificationLadder: string[];
	phaseHappyPath: string[];
	evidenceResults: string[];
}

export interface HostCapabilitiesResult {
	cwd: string;
	host: HostSkillBundleTarget;
	capabilities: unknown[];
	unsupportedCapabilities: unknown[];
	conformanceFixtures: string[];
	sourcePath: string;
}

interface ProjectManifest {
	profile?: { name?: unknown; path?: unknown };
	hosts?: Array<{ host?: unknown; declarationPath?: unknown }>;
	projections?: { indexPath?: unknown; defaultDriftPolicy?: unknown };
}

interface ProfileManifest {
	profile?: string;
	requiredGates?: unknown[];
	scoreThresholds?: unknown[];
	verificationLadder?: string[];
	releaseSupport?: unknown;
}

interface UniversalContract {
	phaseGraph?: { happyPath?: string[] };
	evidenceResults?: string[];
}

interface HostDeclaration {
	host?: string;
	capabilities?: unknown[];
	unsupportedCapabilities?: unknown[];
	conformanceFixtures?: unknown;
	role?: string;
	projectionTargets?: unknown[];
}

const DEFAULT_PROFILE: PavedaProfile = "strict";
const HOSTS: HostSkillBundleTarget[] = ["harness", "claude-code", "codex", "pi", "hermes"];

export function validateContractSource(
	options: ContractValidationOptions = {},
): ContractValidationResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = options.host === undefined ? undefined : parseHostSkillBundleTarget(options.host);
	const profile = parsePavedaProfileValue(options.profile);
	const validators = buildValidators();
	const checks: ContractValidationCheck[] = [];
	const manifestPath = join(cwd, ".paveda", "manifest.json");
	const contractPath = join(cwd, ".paveda", "contract.json");
	const profilePath = join(cwd, ".paveda", "profiles", `${profile}.json`);
	const hostPaths = host
		? [join(cwd, ".paveda", "hosts", `${host}.json`)]
		: listProjectHostFiles(cwd);

	checks.push(validateProjectManifest(manifestPath));
	checks.push(validateJsonFile(contractPath, "contract", validators.universalContract));
	checks.push(validateJsonFile(profilePath, "profile", validators.profileManifest));

	for (const hostPath of hostPaths) {
		checks.push(validateHostFile(hostPath, validators.hostDeclaration));
	}

	const capabilitiesPath = join(cwd, ".paveda", "capabilities.json");
	checks.push(validateCapabilitiesPolicy(capabilitiesPath, validators.hostCapabilityEntry));

	const testPolicyPath = join(cwd, ".paveda", "test-policy.json");
	checks.push(validateRequiredJsonObject(testPolicyPath, "test-policy"));

	if (options.includeProjection !== false && host) {
		checks.push(validateProjectionState(cwd, host));
	}

	return {
		cwd,
		...(host ? { host } : {}),
		profile,
		ok: checks.every((check) => check.status === "pass" || check.status === "not_applicable"),
		checks,
	};
}

export function explainContract(options: ContractExplainOptions = {}): ContractExplainResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const profile = parsePavedaProfileValue(options.profile);
	const contract = readJsonWithFallback<UniversalContract>(
		join(cwd, ".paveda", "contract.json"),
		join(packageHarnessRoot(), "contracts", "universal-contract.v1.json"),
	);
	const profileManifest = readJsonWithFallback<ProfileManifest>(
		join(cwd, ".paveda", "profiles", `${profile}.json`),
		join(packageHarnessRoot(), "contracts", "profiles", `${profile}.json`),
	);

	return {
		cwd,
		profile,
		releaseSupport: profileManifest.releaseSupport ?? null,
		requiredGates: profileManifest.requiredGates ?? [],
		scoreThresholds: profileManifest.scoreThresholds ?? [],
		verificationLadder: asStringArray(profileManifest.verificationLadder),
		phaseHappyPath: asStringArray(contract.phaseGraph?.happyPath),
		evidenceResults: asStringArray(contract.evidenceResults),
	};
}

export function loadHostCapabilities(options: {
	cwd?: string;
	host: HostSkillBundleTarget | string;
}): HostCapabilitiesResult {
	const cwd = resolve(options.cwd ?? process.cwd());
	const host = parseHostSkillBundleTarget(options.host);
	const projectPath = join(cwd, ".paveda", "hosts", `${host}.json`);
	const packagePath = join(packageHarnessRoot(), "hosts", `${host}.json`);
	const sourcePath = existsSync(projectPath) ? projectPath : packagePath;
	const declaration = readJson<HostDeclaration>(sourcePath);

	return {
		cwd,
		host,
		capabilities: declaration.capabilities ?? [],
		unsupportedCapabilities: declaration.unsupportedCapabilities ?? [],
		conformanceFixtures: asStringArray(declaration.conformanceFixtures),
		sourcePath,
	};
}

export function loadProfileManifest(cwd: string, profile: PavedaProfile): ProfileManifest {
	return readJsonWithFallback<ProfileManifest>(
		join(cwd, ".paveda", "profiles", `${profile}.json`),
		join(packageHarnessRoot(), "contracts", "profiles", `${profile}.json`),
	);
}

export function parsePavedaProfileValue(value: string | undefined): PavedaProfile {
	if (value === undefined) {
		return DEFAULT_PROFILE;
	}
	if (value === "fast" || value === "standard" || value === "strict" || value === "release") {
		return value;
	}
	throw new Error(`Invalid Paveda profile: ${value}`);
}

export function assertMvpExecutableProfile(profile: PavedaProfile): void {
	if (profile === "release") {
		throw new Error(
			"Release profile execution is not_supported_in_mvp. Supported MVP execution profiles: fast, standard, strict.",
		);
	}
}

function buildValidators(): {
	universalContract: ValidateFunction;
	profileManifest: ValidateFunction;
	hostDeclaration: ValidateFunction;
	hostCapabilityEntry: ValidateFunction;
} {
	const contractSchema = readJson<AnySchema>(
		join(packageHarnessRoot(), "contracts", "schemas", "contract.schema.json"),
	);
	const capabilitiesSchema = readJson<AnySchema>(
		join(packageHarnessRoot(), "contracts", "schemas", "capabilities.schema.json"),
	);
	const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true });
	ajv.addSchema(capabilitiesSchema);
	ajv.addSchema(contractSchema);

	return {
		universalContract: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/universalContract",
		),
		profileManifest: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/profileManifest",
		),
		hostDeclaration: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/contract.schema.json#/$defs/hostDeclaration",
		),
		hostCapabilityEntry: requiredSchema(
			ajv,
			"https://paveda.dev/schemas/capabilities.schema.json#/$defs/hostCapabilityEntry",
		),
	};
}

function validateProjectManifest(path: string): ContractValidationCheck {
	const manifest = readRequiredJson<ProjectManifest>(path, "manifest");
	if (!manifest.ok) {
		return manifest.check;
	}

	const errors: string[] = [];
	if (
		manifest.value.profile?.name === undefined ||
		typeof manifest.value.profile.path !== "string"
	) {
		errors.push("profile.name and profile.path are required");
	}
	if (!Array.isArray(manifest.value.hosts) || manifest.value.hosts.length === 0) {
		errors.push("hosts[] must contain at least one host declaration");
	}
	if (typeof manifest.value.projections?.indexPath !== "string") {
		errors.push("projections.indexPath is required");
	}
	if (manifest.value.projections?.defaultDriftPolicy !== "block") {
		errors.push("projections.defaultDriftPolicy must be block");
	}

	return errors.length === 0
		? {
				name: "manifest",
				status: "pass",
				message: "Project manifest is valid.",
				path,
			}
		: {
				name: "manifest",
				status: "fail",
				message: "Project manifest is invalid.",
				path,
				errors,
			};
}

function validateJsonFile(
	path: string,
	name: string,
	validate: ValidateFunction,
): ContractValidationCheck {
	const parsed = readRequiredJson<unknown>(path, name);
	if (!parsed.ok) {
		return parsed.check;
	}
	if (validate(parsed.value)) {
		return {
			name,
			status: "pass",
			message: `${name} schema validation passed.`,
			path,
		};
	}
	return {
		name,
		status: "fail",
		message: `${name} schema validation failed.`,
		path,
		errors: formatAjvErrors(validate),
	};
}

function validateHostFile(path: string, validate: ValidateFunction): ContractValidationCheck {
	const parsed = readRequiredJson<HostDeclaration>(path, "host-declaration");
	if (!parsed.ok) {
		return parsed.check;
	}
	if (parsed.value.role === "canonical-bundle-target") {
		const valid =
			parsed.value.host === "harness" &&
			Array.isArray(parsed.value.projectionTargets) &&
			parsed.value.projectionTargets.length > 0;
		return valid
			? {
					name: "host-declaration",
					status: "not_applicable",
					message: "Canonical harness target is not a host declaration schema instance.",
					path,
				}
			: {
					name: "host-declaration",
					status: "fail",
					message: "Canonical harness target declaration is invalid.",
					path,
				};
	}
	if (validate(parsed.value)) {
		return {
			name: "host-declaration",
			status: "pass",
			message: "Host declaration schema validation passed.",
			path,
		};
	}
	return {
		name: "host-declaration",
		status: "fail",
		message: "Host declaration schema validation failed.",
		path,
		errors: formatAjvErrors(validate),
	};
}

function validateCapabilitiesPolicy(
	path: string,
	validateCapability: ValidateFunction,
): ContractValidationCheck {
	const parsed = readRequiredJson<{ capabilities?: unknown[] }>(path, "capabilities");
	if (!parsed.ok) {
		return parsed.check;
	}
	const capabilities = parsed.value.capabilities ?? [];
	if (!Array.isArray(capabilities)) {
		return {
			name: "capabilities",
			status: "fail",
			message: "capabilities must be an array.",
			path,
		};
	}
	const errors = capabilities.flatMap((capability, index) => {
		if (validateCapability(capability)) {
			return [];
		}
		return formatAjvErrors(validateCapability).map((error) => `capabilities[${index}] ${error}`);
	});
	return errors.length === 0
		? {
				name: "capabilities",
				status: "pass",
				message: "Capability entries are valid.",
				path,
			}
		: {
				name: "capabilities",
				status: "fail",
				message: "Capability entries are invalid.",
				path,
				errors,
			};
}

function validateRequiredJsonObject(path: string, name: string): ContractValidationCheck {
	const parsed = readRequiredJson<unknown>(path, name);
	if (!parsed.ok) {
		return parsed.check;
	}
	return parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
		? {
				name,
				status: "pass",
				message: `${name} exists and is a JSON object.`,
				path,
			}
		: {
				name,
				status: "fail",
				message: `${name} must be a JSON object.`,
				path,
			};
}

function validateProjectionState(
	cwd: string,
	host: HostSkillBundleTarget,
): ContractValidationCheck {
	const indexPath = join(cwd, ".paveda", "projections", "index.json");
	if (!existsSync(indexPath)) {
		return {
			name: "projection-drift",
			status: "fail",
			message: "Projection index is missing.",
			path: indexPath,
		};
	}

	return {
		name: "projection-drift",
		status: "pass",
		message: `Projection index exists for ${host}. Run paveda projection status for file-level drift.`,
		path: indexPath,
	};
}

function readRequiredJson<T>(
	path: string,
	name: string,
): { ok: true; value: T } | { ok: false; check: ContractValidationCheck } {
	if (!existsSync(path)) {
		return {
			ok: false,
			check: {
				name,
				status: "fail",
				message: `${name} file is missing.`,
				path,
			},
		};
	}
	try {
		return { ok: true, value: readJson<T>(path) };
	} catch (error) {
		return {
			ok: false,
			check: {
				name,
				status: "fail",
				message: `${name} file is not valid JSON.`,
				path,
				errors: [error instanceof Error ? error.message : String(error)],
			},
		};
	}
}

function listProjectHostFiles(cwd: string): string[] {
	const root = join(cwd, ".paveda", "hosts");
	if (!existsSync(root)) {
		return HOSTS.filter((host) => host !== "harness").map((host) =>
			join(packageHarnessRoot(), "hosts", `${host}.json`),
		);
	}
	return readdirSync(root)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => join(root, entry))
		.sort((left, right) => basename(left).localeCompare(basename(right)));
}

function readJsonWithFallback<T>(projectPath: string, packagePath: string): T {
	return readJson<T>(existsSync(projectPath) ? projectPath : packagePath);
}

function readJson<T = unknown>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requiredSchema(ajv: Ajv, id: string): ValidateFunction {
	const validate = ajv.getSchema(id);
	if (!validate) {
		throw new Error(`Missing schema: ${id}`);
	}
	return validate;
}

function formatAjvErrors(validate: ValidateFunction): string[] {
	return (validate.errors ?? []).map(
		(error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
	);
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function packageHarnessRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "../../assets/harness");
}
