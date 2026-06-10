import { describe, expect, it } from "vitest";
import {
	VERSION,
	blastCheck,
	codexAdapter,
	codexInstall,
	conformance,
	contract,
	costGuard,
	destructiveGuard,
	execution,
	hermesAdapter,
	hermesInstall,
	hooks,
	learning,
	mcp,
	piAdapter,
	piInstall,
	policy,
	projection,
	sessionContext,
	testProcessCleanup,
	toolingEnforce,
	worktreePort,
} from "../src/index.js";

describe("package root exports", () => {
	it("exposes every built-in operational hook module", () => {
		expect(VERSION).toBe("0.1.0");
		expect(typeof sessionContext.collectSessionContext).toBe("function");
		expect(hooks.collectSessionContext).toBe(sessionContext.collectSessionContext);
		expect(typeof costGuard.evaluateCostGuard).toBe("function");
		expect(typeof destructiveGuard.evaluateDestructiveGuard).toBe("function");
		expect(typeof blastCheck.evaluateBlastCheck).toBe("function");
		expect(typeof toolingEnforce.evaluateToolingEnforce).toBe("function");
		expect(typeof testProcessCleanup.evaluateTestProcessCleanup).toBe("function");
		expect(typeof worktreePort.resolveWorktreePorts).toBe("function");
		expect(typeof policy.PolicyEngine).toBe("function");
		expect(typeof policy.createPolicyBundle).toBe("function");
		expect(typeof policy.fetchSignedPolicyBundle).toBe("function");
		expect(typeof policy.verifySignedPolicyBundleWithKeyring).toBe("function");
		expect(typeof policy.verifySignedPolicyBundle).toBe("function");
		expect(typeof codexAdapter.fromCodexHookPayload).toBe("function");
		expect(typeof codexAdapter.normalizeCodexGoalLifecycleEvent).toBe("function");
		expect(typeof hermesAdapter.fromHermesHookPayload).toBe("function");
		expect(typeof piAdapter.fromPiHookPayload).toBe("function");
		expect(typeof codexInstall.installCodex).toBe("function");
		expect(typeof hermesInstall.installHermes).toBe("function");
		expect(typeof piInstall.installPi).toBe("function");
		expect(typeof mcp.handleMcpRequest).toBe("function");
		expect(typeof contract.validateContractSource).toBe("function");
		expect(typeof conformance.runConformance).toBe("function");
		expect(typeof execution.startPavedaDo).toBe("function");
		expect(typeof learning.promoteLearningPattern).toBe("function");
		expect(typeof projection.checkProjectionStatus).toBe("function");
	});
});
