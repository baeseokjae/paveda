import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateBlastCheck } from "../hooks/blast-check.js";
import { evaluateDestructiveGuard } from "../hooks/destructive-guard.js";
import { evaluateToolingEnforce } from "../hooks/tooling-enforce.js";
import type { HostSkillBundleTarget } from "../host-bundles/index.js";
import { PolicyEngine, normalizeAgentEvent, resolveHostCapability } from "../policy/index.js";
import type {
	AgentEvent,
	EnforcementTier,
	HostCapability,
	PolicyDecision,
	PolicyRuntimeSource,
	PolicySourceResults,
	WorkflowState,
} from "../policy/index.js";
import type { DoctorCheck, DoctorCheckStatus } from "./index.js";

interface EnforcementDoctorOptions {
	cwd: string;
	host?: HostSkillBundleTarget;
	policySource?: PolicyRuntimeSource;
}

interface EnforcementProbe {
	name: string;
	label: string;
	toolMatchers: string[];
	requiresPreToolBlock: boolean;
	allowMcpMediation: boolean;
	remediation: string;
}

interface EnforcementProbeDetails {
	host: string;
	action: string;
	toolMatchers: string[];
	effectiveTier: EnforcementTier;
	passedProbes: string[];
	failedProbes: string[];
	bypassPaths: string[];
	requiredRemediation: string[];
	configFiles: string[];
	managedConfigActive: boolean | null;
	policySource: PolicyRuntimeSource;
	hostCapability: HostCapability;
	syntheticProbe: SyntheticProbeResult;
}

interface SyntheticProbeResult {
	executed: boolean;
	passed: boolean | null;
	expectedRuleIds: string[];
	decisions: SyntheticPolicyDecision[];
	reason: string;
}

interface SyntheticPolicyDecision {
	ruleId: string;
	action: PolicyDecision["action"];
	severity: PolicyDecision["severity"];
	tier: EnforcementTier;
	enforced: boolean;
}

const ENFORCEMENT_PROBES: readonly EnforcementProbe[] = [
	{
		name: "destructive-shell-command",
		label: "destructive shell command",
		toolMatchers: ["Bash"],
		requiresPreToolBlock: true,
		allowMcpMediation: true,
		remediation: "Install native hooks or route shell execution through paveda.shell.",
	},
	{
		name: "sensitive-file-mutation",
		label: "sensitive file mutation",
		toolMatchers: ["Edit", "Write", "apply_patch", "Bash"],
		requiresPreToolBlock: true,
		allowMcpMediation: true,
		remediation: "Install native file mutation hooks or route file writes through paveda.patch.",
	},
	{
		name: "dependency-manifest-mutation",
		label: "dependency manifest mutation",
		toolMatchers: ["Edit", "Write", "apply_patch"],
		requiresPreToolBlock: false,
		allowMcpMediation: true,
		remediation: "Keep manifest changes visible to Paveda and verify lockfile updates.",
	},
	{
		name: "verification-before-commit",
		label: "verification before commit",
		toolMatchers: ["Bash", "Git", "mcp"],
		requiresPreToolBlock: true,
		allowMcpMediation: true,
		remediation: "Route git commit through paveda.git or install a native commit gate.",
	},
	{
		name: "verification-before-pr",
		label: "verification before PR",
		toolMatchers: ["Bash", "GitHub", "mcp"],
		requiresPreToolBlock: true,
		allowMcpMediation: true,
		remediation: "Route PR creation through paveda.git or install a native PR gate.",
	},
	{
		name: "mcp-routed-tool-call",
		label: "MCP-routed tool call",
		toolMatchers: ["mcp"],
		requiresPreToolBlock: false,
		allowMcpMediation: true,
		remediation: "Enable paveda mcp serve and prefer Paveda wrapper tools.",
	},
	{
		name: "native-tool-bypass",
		label: "native tool bypass surface",
		toolMatchers: ["native"],
		requiresPreToolBlock: false,
		allowMcpMediation: false,
		remediation:
			"Restrict native tools, use managed config where available, or treat as verify tier.",
	},
];

export function checkEnforcement(options: EnforcementDoctorOptions): DoctorCheck[] {
	if (!options.host) {
		return [
			{
				name: "enforcement-host",
				status: "fail",
				message: "Enforcement doctor requires --host so capability can be assessed.",
			},
		];
	}

	const hostCapability = resolveHostCapability(options.host);
	return ENFORCEMENT_PROBES.map((probe) => {
		const details = buildProbeDetails({
			cwd: options.cwd,
			host: options.host as HostSkillBundleTarget,
			hostCapability,
			policySource: options.policySource ?? { type: "local" },
			probe,
		});
		const status = statusForProbe(details);

		return {
			name: `enforcement-${probe.name}`,
			status,
			message: `${probe.label}: ${details.effectiveTier} tier for ${options.host}.`,
			details,
		};
	});
}

function buildProbeDetails(input: {
	cwd: string;
	host: HostSkillBundleTarget;
	hostCapability: HostCapability;
	policySource: PolicyRuntimeSource;
	probe: EnforcementProbe;
}): EnforcementProbeDetails {
	const effectiveTier = resolveEffectiveTier(input.hostCapability, input.probe);
	const bypassPaths = resolveBypassPaths(input.hostCapability, input.probe);
	const configFiles = configFilesForHost(input.host);
	const managedConfigActive = managedConfigActiveForHost(input.cwd, input.host);
	const syntheticProbe = runSyntheticProbe({
		host: input.host,
		hostCapability: input.hostCapability,
		probe: input.probe,
	});
	const requiredRemediation =
		effectiveTier === "block" || effectiveTier === "gate" ? [] : [input.probe.remediation];

	return {
		host: input.host,
		action: input.probe.name,
		toolMatchers: input.probe.toolMatchers,
		effectiveTier,
		passedProbes: [`capability:${effectiveTier}`],
		failedProbes: effectiveTier === "verify" ? ["native-pre-tool-enforcement"] : [],
		bypassPaths,
		requiredRemediation,
		configFiles,
		managedConfigActive,
		policySource: input.policySource,
		hostCapability: input.hostCapability,
		syntheticProbe,
	};
}

function runSyntheticProbe(input: {
	host: HostSkillBundleTarget;
	hostCapability: HostCapability;
	probe: EnforcementProbe;
}): SyntheticProbeResult {
	const syntheticInput = buildSyntheticPolicyInput(input.host, input.probe);
	if (!syntheticInput) {
		return {
			executed: false,
			passed: null,
			expectedRuleIds: [],
			decisions: [],
			reason: "No synthetic policy probe is defined for this action yet.",
		};
	}

	const evaluation = new PolicyEngine({ hostCapability: input.hostCapability }).evaluate({
		event: syntheticInput.event,
		...(syntheticInput.sourceResults ? { sourceResults: syntheticInput.sourceResults } : {}),
		...(syntheticInput.workflowState ? { workflowState: syntheticInput.workflowState } : {}),
	});
	const decisions = evaluation.decisions.map(toSyntheticPolicyDecision);
	const passed = syntheticInput.expectedRuleIds.every((ruleId) =>
		decisions.some((decision) => decision.ruleId === ruleId),
	);

	return {
		executed: true,
		passed,
		expectedRuleIds: syntheticInput.expectedRuleIds,
		decisions,
		reason: passed
			? "Synthetic event produced the expected policy decision."
			: "Synthetic event did not produce the expected policy decision.",
	};
}

function buildSyntheticPolicyInput(
	host: HostSkillBundleTarget,
	probe: EnforcementProbe,
):
	| {
			event: AgentEvent;
			sourceResults?: PolicySourceResults;
			workflowState?: WorkflowState;
			expectedRuleIds: string[];
	  }
	| undefined {
	const sessionId = `doctor-enforcement-${probe.name}`;
	const ts = 100;

	if (probe.name === "destructive-shell-command") {
		const toolPayload = { toolName: "Bash", toolInput: { command: "rm -rf /" } };
		return {
			event: normalizeAgentEvent({
				sessionId,
				lifecycle: "tool.execute.before",
				matcher: "Bash",
				ts,
				payload: toToolPayload(host, "Bash", toolPayload.toolInput),
			}),
			sourceResults: {
				toolPayload,
				destructiveGuard: evaluateDestructiveGuard(toolPayload),
				toolingEnforce: evaluateToolingEnforce(toolPayload),
			},
			expectedRuleIds: ["D-003"],
		};
	}

	if (probe.name === "sensitive-file-mutation") {
		const toolPayload = { toolName: "Edit", toolInput: { file_path: "/repo/.env.local" } };
		return {
			event: normalizeAgentEvent({
				sessionId,
				lifecycle: "tool.execute.before",
				matcher: "Edit",
				ts,
				payload: toToolPayload(host, "Edit", toolPayload.toolInput),
			}),
			sourceResults: {
				toolPayload,
				destructiveGuard: evaluateDestructiveGuard(toolPayload),
				blastCheck: evaluateBlastCheck(toolPayload),
			},
			expectedRuleIds: ["D-004"],
		};
	}

	if (probe.name === "dependency-manifest-mutation") {
		const toolPayload = {
			toolName: "Edit",
			toolInput: {
				file_path: "/repo/package.json",
				new_string: '"dependencies": { "typescript": "^5.9.0" }',
			},
		};
		return {
			event: normalizeAgentEvent({
				sessionId,
				lifecycle: "tool.execute.before",
				matcher: "Edit",
				ts,
				payload: toToolPayload(host, "Edit", toolPayload.toolInput),
			}),
			sourceResults: {
				toolPayload,
				destructiveGuard: evaluateDestructiveGuard(toolPayload),
				blastCheck: evaluateBlastCheck(toolPayload),
			},
			expectedRuleIds: ["B-001"],
		};
	}

	if (probe.name === "verification-before-commit" || probe.name === "verification-before-pr") {
		const command =
			probe.name === "verification-before-commit" ? "git commit -m change" : "gh pr create";
		const toolPayload = { toolName: "Bash", toolInput: { command } };
		return {
			event: normalizeAgentEvent({
				sessionId,
				lifecycle: "tool.execute.before",
				matcher: "Bash",
				ts,
				payload: toToolPayload(host, "Bash", toolPayload.toolInput),
			}),
			sourceResults: {
				toolPayload,
				destructiveGuard: evaluateDestructiveGuard(toolPayload),
				toolingEnforce: evaluateToolingEnforce(toolPayload),
			},
			workflowState: {
				phase: "executing",
				mutationRequiresApproval: false,
				mutationBlockReason: null,
				rootCauseEvidenceRequired: false,
				rootCauseEvidenceObserved: false,
				pendingVerification: true,
				lastPrompt: null,
				evidence: ["mutation:Edit"],
				updatedAt: ts,
			},
			expectedRuleIds: ["W-003"],
		};
	}

	return undefined;
}

function toToolPayload(
	host: HostSkillBundleTarget,
	toolName: string,
	toolInput: unknown,
): Record<string, unknown> {
	return {
		host,
		tool: toolName,
		raw: {
			tool_name: toolName,
			tool_input: toolInput,
		},
	};
}

function toSyntheticPolicyDecision(decision: PolicyDecision): SyntheticPolicyDecision {
	return {
		ruleId: decision.ruleId,
		action: decision.action,
		severity: decision.severity,
		tier: decision.tier,
		enforced: decision.enforced,
	};
}

function resolveEffectiveTier(
	hostCapability: HostCapability,
	probe: EnforcementProbe,
): EnforcementTier {
	if (probe.name === "native-tool-bypass") {
		return hostCapability.nativeToolBypassRisk === "none" ? "block" : "verify";
	}

	if (!probe.requiresPreToolBlock && probe.name === "mcp-routed-tool-call") {
		return hostCapability.supportsMcpGateway ? "mediate" : "verify";
	}

	if (
		probe.requiresPreToolBlock &&
		hostCapability.canBlockBeforeTool &&
		hasCoveredMatcher(hostCapability, probe.toolMatchers)
	) {
		return "block";
	}

	if (probe.requiresPreToolBlock && hostCapability.canGatePermissionRequest) {
		return "gate";
	}

	if (probe.allowMcpMediation && hostCapability.supportsMcpGateway) {
		return "mediate";
	}

	return "verify";
}

function hasCoveredMatcher(hostCapability: HostCapability, matchers: readonly string[]): boolean {
	return matchers.some(
		(matcher) =>
			hostCapability.coveredToolMatchers.includes(matcher) ||
			hostCapability.coveredToolMatchers.includes("*"),
	);
}

function resolveBypassPaths(hostCapability: HostCapability, probe: EnforcementProbe): string[] {
	const bypassPaths: string[] = [];

	if (hostCapability.nativeToolBypassRisk !== "none") {
		bypassPaths.push(`native-tool-bypass:${hostCapability.nativeToolBypassRisk}`);
	}

	if (probe.allowMcpMediation && hostCapability.supportsMcpGateway) {
		bypassPaths.push("native tools remain outside MCP mediation unless restricted");
	}

	return bypassPaths;
}

function statusForProbe(details: EnforcementProbeDetails): DoctorCheckStatus {
	if (details.effectiveTier === "block" || details.effectiveTier === "gate") {
		return "pass";
	}

	return "warn";
}

function configFilesForHost(host: HostSkillBundleTarget): string[] {
	switch (host) {
		case "claude-code":
			return [".claude/settings.json"];
		case "codex":
			return [".codex/hooks.json", "requirements.toml"];
		case "hermes":
			return [".hermes/config.yaml", ".hermes/agent-hooks/paveda-policy.sh"];
		case "pi":
			return [".pi/extensions/paveda-policy.ts", ".pi/AGENTS.md"];
		case "harness":
			return [".harness/AGENTS.md"];
	}
}

function managedConfigActiveForHost(cwd: string, host: HostSkillBundleTarget): boolean | null {
	if (host !== "codex") {
		return null;
	}

	const path = join(cwd, "requirements.toml");
	if (!existsSync(path)) {
		return false;
	}

	const content = readFileSync(path, "utf8");
	return (
		content.includes("allow_managed_hooks_only = true") &&
		content.includes("[features]") &&
		content.includes("hooks = true") &&
		content.includes("[hooks]") &&
		content.includes("managed_dir")
	);
}
