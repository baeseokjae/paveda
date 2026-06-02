import type { BlastCheckResult, EvaluateBlastCheckInput } from "../hooks/blast-check.js";
import type { CostGuardResult } from "../hooks/cost-guard.js";
import type {
	DestructiveGuardResult,
	EvaluateDestructiveGuardInput,
} from "../hooks/destructive-guard.js";
import type { TestProcessCleanupResult } from "../hooks/test-process-cleanup.js";
import type {
	EvaluateToolingEnforceInput,
	ToolingEnforceResult,
} from "../hooks/tooling-enforce.js";
import type { WorkflowState } from "./state.js";

export type AgentEventKind =
	| "session.started"
	| "prompt.submitted"
	| "tool.requested"
	| "tool.completed"
	| "file.mutated"
	| "verification.completed"
	| "session.stopped";

export type PolicyDecisionAction =
	| "allow"
	| "warn"
	| "deny"
	| "ask"
	| "require_step"
	| "record_only";

export type PolicySeverity = "info" | "low" | "medium" | "high" | "critical";

export type EnforcementTier = "block" | "gate" | "mediate" | "verify";

export interface AgentToolEvent {
	name: string;
	input?: unknown;
	response?: unknown;
}

export interface AgentFileMutation {
	path?: string;
	paths: string[];
	kind: "edit" | "write" | "patch" | "unknown";
}

export interface AgentEvent {
	sessionId: string;
	kind: AgentEventKind;
	host: string;
	ts: number;
	cwd?: string;
	lifecycle?: string;
	matcher?: string;
	tool?: AgentToolEvent;
	fileMutation?: AgentFileMutation;
	raw?: unknown;
}

export interface HostCapability {
	host: string;
	canBlockBeforeTool: boolean;
	canGatePermissionRequest: boolean;
	canRewriteToolInput: boolean;
	canStopAfterTool: boolean;
	supportsManagedConfig: boolean;
	supportsMcpGateway: boolean;
	nativeToolBypassRisk: "none" | "low" | "medium" | "high";
	coveredToolMatchers: string[];
}

export interface PolicyDecision {
	ruleId: string;
	action: PolicyDecisionAction;
	severity: PolicySeverity;
	tier: EnforcementTier;
	reason: string;
	requiredCapability: keyof HostCapability | "verification" | "none";
	suggestedRemediation?: string;
	evidence: unknown;
	enforced: boolean;
}

export interface PolicyEvaluation {
	event: AgentEvent;
	hostCapability: HostCapability;
	policySource: PolicyRuntimeSource;
	workflowState?: WorkflowState;
	decisions: PolicyDecision[];
}

export interface PolicyRule {
	id: string;
	description: string;
	version?: number;
	fingerprint?: string;
	parameters?: Record<string, unknown>;
	evaluate(input: PolicyRuleInput): PolicyDecision[];
}

export interface PolicyRuleInput {
	event: AgentEvent;
	hostCapability: HostCapability;
	policySource: PolicyRuntimeSource;
	workflowState?: WorkflowState;
	sourceResults?: PolicySourceResults;
}

export interface PolicyRuntimeSource {
	type: "local" | "bundle-cache";
	source?: string;
	cachePath?: string;
	cachedAt?: string;
	issuer?: string;
	generatedAt?: string;
	runtimeVersion?: string;
	canonicalSha256?: string;
	keyId?: string;
}

export interface PolicySourceResults {
	toolPayload?: EvaluateDestructiveGuardInput &
		EvaluateToolingEnforceInput &
		EvaluateBlastCheckInput;
	destructiveGuard?: DestructiveGuardResult;
	toolingEnforce?: ToolingEnforceResult;
	blastCheck?: BlastCheckResult;
	costGuard?: CostGuardResult;
	testProcessCleanup?: TestProcessCleanupResult;
}
