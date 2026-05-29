import { describe, expect, it } from "vitest";
import {
	asciiSum,
	formatWorktreePortsAsShell,
	resolveWorktreePorts,
	worktreeOffset,
} from "../src/hooks/worktree-port.js";

describe("worktree port resolver", () => {
	it("computes the deterministic ascii offset", () => {
		expect(asciiSum("abc")).toBe(294);
		expect(worktreeOffset("abc")).toBe(94);
	});

	it("resolves base ports with deterministic worktree offset", async () => {
		const result = await resolveWorktreePorts({
			worktreeName: "paveda",
			isPortAvailable: () => true,
		});

		expect(result).toEqual({
			worktreeName: "paveda",
			offset: 25,
			ports: {
				PORT: 3025,
				API_PORT: 3026,
				AUX_PORT: 3027,
			},
		});
	});

	it("scans up to ten ports and falls back to the base port when all candidates are occupied", async () => {
		const result = await resolveWorktreePorts({
			worktreeName: "abc",
			isPortAvailable: (port) => port !== 3000 + 94 && port !== 3001 + 94 && port !== 3002 + 94,
		});

		expect(result.ports).toEqual({
			PORT: 3097,
			API_PORT: 3097,
			AUX_PORT: 3097,
		});

		const occupiedPortCandidates = new Set(
			Array.from({ length: 10 }, (_, index) => 3000 + 94 + index),
		);
		const fallback = await resolveWorktreePorts({
			worktreeName: "abc",
			isPortAvailable: (port) => !occupiedPortCandidates.has(port),
		});

		expect(fallback.ports.PORT).toBe(3000);
		expect(fallback.ports.API_PORT).toBe(3104);
		expect(fallback.ports.AUX_PORT).toBe(3104);
	});

	it("formats shell exports for eval usage", async () => {
		const result = await resolveWorktreePorts({
			worktreeName: "paveda",
			isPortAvailable: () => true,
		});

		expect(formatWorktreePortsAsShell(result)).toBe(
			["export PORT=3025", "export API_PORT=3026", "export AUX_PORT=3027"].join("\n"),
		);
	});
});
