import { resolveHostCapability } from "./host-capability.js";
import { DEFAULT_POLICY_RULES } from "./rules.js";
import type { WorkflowState } from "./state.js";
import type {
	AgentEvent,
	HostCapability,
	PolicyEvaluation,
	PolicyRule,
	PolicyRuntimeSource,
	PolicySourceResults,
} from "./types.js";

export interface PolicyEngineOptions {
	rules?: readonly PolicyRule[];
	hostCapability?: HostCapability;
	policySource?: PolicyRuntimeSource;
}

export interface EvaluatePolicyInput {
	event: AgentEvent;
	sourceResults?: PolicySourceResults;
	hostCapability?: HostCapability;
	policySource?: PolicyRuntimeSource;
	workflowState?: WorkflowState;
}

export class PolicyEngine {
	private readonly rules: readonly PolicyRule[];
	private readonly defaultHostCapability?: HostCapability;
	private readonly defaultPolicySource?: PolicyRuntimeSource;

	constructor(options: PolicyEngineOptions = {}) {
		this.rules = options.rules ?? DEFAULT_POLICY_RULES;
		this.defaultHostCapability = options.hostCapability;
		this.defaultPolicySource = options.policySource;
	}

	evaluate(input: EvaluatePolicyInput): PolicyEvaluation {
		const hostCapability =
			input.hostCapability ?? this.defaultHostCapability ?? resolveHostCapability(input.event.host);
		const policySource =
			input.policySource ?? this.defaultPolicySource ?? DEFAULT_POLICY_RUNTIME_SOURCE;
		const decisions = this.rules.flatMap((rule) =>
			rule.evaluate({
				event: input.event,
				hostCapability,
				policySource,
				workflowState: input.workflowState,
				sourceResults: input.sourceResults,
			}),
		);

		return {
			event: input.event,
			hostCapability,
			policySource,
			...(input.workflowState ? { workflowState: input.workflowState } : {}),
			decisions,
		};
	}
}

const DEFAULT_POLICY_RUNTIME_SOURCE: PolicyRuntimeSource = Object.freeze({ type: "local" });
