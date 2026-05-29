import { describe, expect, it } from "vitest";
import {
	VERSION,
	blastCheck,
	costGuard,
	destructiveGuard,
	hooks,
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
	});
});
