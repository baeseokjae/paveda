import { describe, expect, it } from "vitest";
import {
	PolicyEngine,
	normalizeAgentEvent,
	projectWorkflowState,
	resolveHostCapability,
} from "../src/policy/index.js";

describe("policy runtime", () => {
	it("normalizes lifecycle payloads into AgentEvent records", () => {
		const event = normalizeAgentEvent({
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Edit",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Edit",
				raw: {
					tool_input: {
						file_path: "/repo/package.json",
						new_string: '"dependencies": { "typescript": "^5.9.0" }',
					},
				},
			},
		});

		expect(event).toMatchObject({
			sessionId: "session-1",
			kind: "tool.requested",
			host: "claude-code",
			ts: 100,
			lifecycle: "tool.execute.before",
			matcher: "Edit",
			tool: {
				name: "Edit",
				input: {
					file_path: "/repo/package.json",
				},
			},
			fileMutation: {
				kind: "edit",
				path: "/repo/package.json",
				paths: ["/repo/package.json"],
			},
		});
	});

	it("maps guard source results to host-aware policy decisions", () => {
		const engine = new PolicyEngine();
		const event = normalizeAgentEvent({
			sessionId: "session-2",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 200,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: {
					tool_input: { command: "echo API_KEY=secret >> .env" },
				},
			},
		});

		const evaluation = engine.evaluate({
			event,
			sourceResults: {
				destructiveGuard: {
					decision: "deny",
					ruleId: "D-001",
					reason: "D-001: Writing directly to .env files is blocked.",
					additionalContext: null,
				},
			},
		});

		expect(evaluation.hostCapability).toMatchObject({
			host: "claude-code",
			canBlockBeforeTool: true,
		});
		expect(evaluation.decisions).toMatchObject([
			{
				ruleId: "D-001",
				action: "deny",
				severity: "critical",
				tier: "block",
				requiredCapability: "canBlockBeforeTool",
				enforced: true,
			},
		]);
	});

	it("downgrades hard decisions when a host cannot block native tool calls", () => {
		const engine = new PolicyEngine({
			hostCapability: resolveHostCapability("legacy-host"),
		});
		const event = normalizeAgentEvent({
			sessionId: "session-3",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 300,
			payload: {
				host: "legacy-host",
				tool: "Bash",
				raw: {
					tool_input: { command: "rm -rf /" },
				},
			},
		});

		const evaluation = engine.evaluate({
			event,
			sourceResults: {
				destructiveGuard: {
					decision: "deny",
					ruleId: "D-003",
					reason: "D-003: Recursive force removal is blocked.",
					additionalContext: null,
				},
			},
		});

		expect(evaluation.decisions).toMatchObject([
			{
				ruleId: "D-003",
				action: "deny",
				tier: "verify",
				enforced: false,
			},
		]);
	});

	it("projects workflow state from EventStore events", () => {
		const state = projectWorkflowState([
			{
				id: 1,
				sessionId: "session-4",
				ts: 100,
				type: "prompt.submitted",
				payload: { prompt: "계획만 세워줘. 아직 수정하지 마." },
			},
			{
				id: 2,
				sessionId: "session-4",
				ts: 200,
				type: "tool.execute.before",
				payload: {
					tool: "Edit",
					raw: { tool_input: { file_path: "/repo/src/index.ts" } },
				},
			},
		]);

		expect(state).toMatchObject({
			phase: "executing",
			mutationRequiresApproval: true,
			pendingVerification: true,
			lastPrompt: "계획만 세워줘. 아직 수정하지 마.",
		});
	});

	it("blocks file mutation when workflow state requires explicit approval", () => {
		const engine = new PolicyEngine();
		const event = normalizeAgentEvent({
			sessionId: "session-5",
			lifecycle: "tool.execute.before",
			matcher: "Edit",
			ts: 200,
			payload: {
				host: "claude-code",
				tool: "Edit",
				raw: { tool_input: { file_path: "/repo/src/index.ts" } },
			},
		});

		const evaluation = engine.evaluate({
			event,
			workflowState: {
				phase: "planning",
				mutationRequiresApproval: true,
				mutationBlockReason: "User asked for planning only.",
				rootCauseEvidenceRequired: false,
				rootCauseEvidenceObserved: false,
				pendingVerification: false,
				lastPrompt: "plan only",
				evidence: [],
				updatedAt: 100,
			},
		});

		expect(evaluation.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "W-001",
					action: "deny",
					tier: "block",
					enforced: true,
				}),
			]),
		);
	});

	it("treats Bash redirection as a workflow file mutation", () => {
		const engine = new PolicyEngine();
		const event = normalizeAgentEvent({
			sessionId: "session-6",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 200,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: { tool_input: { command: "echo changed > src/index.ts" } },
			},
		});

		const evaluation = engine.evaluate({
			event,
			workflowState: {
				phase: "planning",
				mutationRequiresApproval: true,
				mutationBlockReason: "User asked for planning only.",
				rootCauseEvidenceRequired: false,
				rootCauseEvidenceObserved: false,
				pendingVerification: false,
				lastPrompt: "plan only",
				evidence: [],
				updatedAt: 100,
			},
		});

		expect(evaluation.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "W-001",
					action: "deny",
				}),
			]),
		);
	});
});
