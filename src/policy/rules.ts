import { isWorkflowCommitOrPrEvent, isWorkflowFileMutationEvent } from "./state.js";
import type {
	AgentEvent,
	EnforcementTier,
	HostCapability,
	PolicyDecision,
	PolicyRule,
	PolicyRuleInput,
	PolicySeverity,
	PolicySourceResults,
} from "./types.js";

export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = [
	{
		id: "harness.destructive.guard",
		description: "Blocks or warns for destructive shell and file mutation actions.",
		evaluate: evaluateDestructiveGuardRule,
	},
	{
		id: "harness.tooling.enforce",
		description: "Requires preferred agent-native tools instead of shell file helpers.",
		evaluate: evaluateToolingEnforceRule,
	},
	{
		id: "harness.blast.check",
		description: "Warns when high-blast-radius files such as dependency manifests change.",
		evaluate: evaluateBlastCheckRule,
	},
	{
		id: "harness.cost.guard",
		description: "Warns when a session is likely to need compaction or reset.",
		evaluate: evaluateCostGuardRule,
	},
	{
		id: "harness.test.process.cleanup",
		description: "Records test-process cleanup side effects after test commands.",
		evaluate: evaluateTestProcessCleanupRule,
	},
	{
		id: "workflow.plan-only.mutation-gate",
		description: "Blocks file mutations after a plan-only prompt until explicit approval.",
		evaluate: evaluatePlanOnlyMutationRule,
	},
	{
		id: "workflow.root-cause.mutation-gate",
		description: "Blocks mutations during root-cause requests until evidence is observed.",
		evaluate: evaluateRootCauseMutationRule,
	},
	{
		id: "workflow.verification.handoff-gate",
		description: "Blocks commit, push, and PR handoff while verification evidence is pending.",
		evaluate: evaluateVerificationHandoffRule,
	},
];

function evaluateDestructiveGuardRule(input: PolicyRuleInput): PolicyDecision[] {
	if (!isToolPolicyEvent(input.event)) {
		return [];
	}

	const result = input.sourceResults?.destructiveGuard;
	if (!result) {
		return [];
	}

	if (result.decision === "allow") {
		return [];
	}

	return [
		{
			ruleId: result.ruleId ?? "D-000",
			action: result.decision,
			severity: result.decision === "deny" ? "critical" : "medium",
			tier: tierForToolRequest(input.hostCapability, result.decision === "deny"),
			reason: result.reason ?? "Destructive action policy matched.",
			requiredCapability: result.decision === "deny" ? "canBlockBeforeTool" : "verification",
			suggestedRemediation: result.additionalContext ?? undefined,
			evidence: {
				policy: "harness.destructive.guard",
				event: evidenceFromEvent(input.event),
				result,
			},
			enforced: result.decision === "deny" && canBlockToolRequest(input.hostCapability),
		},
	];
}

function evaluateToolingEnforceRule(input: PolicyRuleInput): PolicyDecision[] {
	if (!isToolPolicyEvent(input.event)) {
		return [];
	}

	const result = input.sourceResults?.toolingEnforce;
	if (!result) {
		return [];
	}

	if (result.decision === "allow") {
		return [];
	}

	return [
		{
			ruleId: result.ruleId ?? "T-000",
			action: "deny",
			severity: "medium",
			tier: tierForToolRequest(input.hostCapability, true),
			reason: result.reason ?? "Tooling policy matched.",
			requiredCapability: "canBlockBeforeTool",
			suggestedRemediation: result.alternative ? `Use ${result.alternative} instead.` : undefined,
			evidence: {
				policy: "harness.tooling.enforce",
				event: evidenceFromEvent(input.event),
				result,
			},
			enforced: canBlockToolRequest(input.hostCapability),
		},
	];
}

function evaluateBlastCheckRule(input: PolicyRuleInput): PolicyDecision[] {
	if (!isToolPolicyEvent(input.event)) {
		return [];
	}

	const result = input.sourceResults?.blastCheck;
	if (!result) {
		return [];
	}

	if (result.warnings.length === 0) {
		return [];
	}

	return result.warnings.map((warning, index) => ({
		ruleId: `B-${String(index + 1).padStart(3, "0")}`,
		action: "warn",
		severity: "medium",
		tier: "verify",
		reason: warning,
		requiredCapability: "verification",
		suggestedRemediation: result.additionalContext ?? undefined,
		evidence: {
			policy: "harness.blast.check",
			event: evidenceFromEvent(input.event),
			result,
		},
		enforced: false,
	}));
}

function evaluateCostGuardRule(input: PolicyRuleInput): PolicyDecision[] {
	const result = input.sourceResults?.costGuard;
	if (!result || result.warnings.length === 0) {
		return [];
	}

	return result.warnings.map((warning, index) => ({
		ruleId: `C-${String(index + 1).padStart(3, "0")}`,
		action: "require_step",
		severity: "low",
		tier: "verify",
		reason: warning,
		requiredCapability: "verification",
		suggestedRemediation: "/compact or start a fresh session.",
		evidence: {
			policy: "harness.cost.guard",
			event: evidenceFromEvent(input.event),
			result,
		},
		enforced: false,
	}));
}

function evaluateTestProcessCleanupRule(input: PolicyRuleInput): PolicyDecision[] {
	const result = input.sourceResults?.testProcessCleanup;
	if (!result?.matched) {
		return [];
	}

	return [
		{
			ruleId: "TP-001",
			action: "record_only",
			severity: "info",
			tier: "verify",
			reason: "Test process cleanup evaluated after a test command.",
			requiredCapability: "none",
			evidence: {
				policy: "harness.test.process.cleanup",
				event: evidenceFromEvent(input.event),
				result,
			},
			enforced: false,
		},
	];
}

function evaluatePlanOnlyMutationRule(input: PolicyRuleInput): PolicyDecision[] {
	const state = input.workflowState;
	if (!state?.mutationRequiresApproval || !isWorkflowFileMutationEvent(input.event)) {
		return [];
	}

	return [
		{
			ruleId: "W-001",
			action: "deny",
			severity: "high",
			tier: tierForToolRequest(input.hostCapability, true),
			reason:
				state.mutationBlockReason ??
				"File mutation is blocked until the user explicitly approves execution.",
			requiredCapability: "canBlockBeforeTool",
			suggestedRemediation: "Ask for explicit approval before editing files.",
			evidence: {
				policy: "workflow.plan-only.mutation-gate",
				event: evidenceFromEvent(input.event),
				workflowState: state,
			},
			enforced: canBlockToolRequest(input.hostCapability),
		},
	];
}

function evaluateRootCauseMutationRule(input: PolicyRuleInput): PolicyDecision[] {
	const state = input.workflowState;
	if (
		!state?.rootCauseEvidenceRequired ||
		state.rootCauseEvidenceObserved ||
		!isWorkflowFileMutationEvent(input.event)
	) {
		return [];
	}

	return [
		{
			ruleId: "W-002",
			action: "deny",
			severity: "high",
			tier: tierForToolRequest(input.hostCapability, true),
			reason: "Root-cause request requires evidence before code or file mutation.",
			requiredCapability: "canBlockBeforeTool",
			suggestedRemediation: "Collect and record root-cause evidence before editing files.",
			evidence: {
				policy: "workflow.root-cause.mutation-gate",
				event: evidenceFromEvent(input.event),
				workflowState: state,
			},
			enforced: canBlockToolRequest(input.hostCapability),
		},
	];
}

function evaluateVerificationHandoffRule(input: PolicyRuleInput): PolicyDecision[] {
	const state = input.workflowState;
	if (!state?.pendingVerification || !isWorkflowCommitOrPrEvent(input.event)) {
		return [];
	}

	return [
		{
			ruleId: "W-003",
			action: "deny",
			severity: "high",
			tier: tierForToolRequest(input.hostCapability, true),
			reason: "Commit, push, or PR handoff is blocked until verification evidence is recorded.",
			requiredCapability: "canBlockBeforeTool",
			suggestedRemediation: "Run relevant verification and retry the handoff after it passes.",
			evidence: {
				policy: "workflow.verification.handoff-gate",
				event: evidenceFromEvent(input.event),
				workflowState: state,
			},
			enforced: canBlockToolRequest(input.hostCapability),
		},
	];
}

export function decisionsFromPolicySourceResults(input: {
	event: AgentEvent;
	hostCapability: HostCapability;
	sourceResults: PolicySourceResults;
}): PolicyDecision[] {
	return DEFAULT_POLICY_RULES.flatMap((rule) =>
		rule.evaluate({
			event: input.event,
			hostCapability: input.hostCapability,
			policySource: { type: "local" },
			sourceResults: input.sourceResults,
		}),
	);
}

function isToolPolicyEvent(event: AgentEvent): boolean {
	return event.kind === "tool.requested" || event.kind === "tool.completed";
}

function evidenceFromEvent(event: AgentEvent): Record<string, unknown> {
	return {
		kind: event.kind,
		host: event.host,
		lifecycle: event.lifecycle,
		matcher: event.matcher,
		toolName: event.tool?.name,
		cwd: event.cwd,
		fileMutation: event.fileMutation,
	};
}

function tierForToolRequest(
	hostCapability: HostCapability,
	requiresPreToolBlock: boolean,
): EnforcementTier {
	if (!requiresPreToolBlock) {
		return "verify";
	}

	if (canBlockToolRequest(hostCapability)) {
		return "block";
	}

	if (hostCapability.canGatePermissionRequest) {
		return "gate";
	}

	return hostCapability.supportsMcpGateway ? "mediate" : "verify";
}

function canBlockToolRequest(hostCapability: HostCapability): boolean {
	return hostCapability.canBlockBeforeTool;
}

export function severityRank(severity: PolicySeverity): number {
	switch (severity) {
		case "critical":
			return 5;
		case "high":
			return 4;
		case "medium":
			return 3;
		case "low":
			return 2;
		case "info":
			return 1;
	}
}
