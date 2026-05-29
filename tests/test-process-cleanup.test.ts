import { describe, expect, it } from "vitest";
import { evaluateTestProcessCleanup } from "../src/hooks/test-process-cleanup.js";

describe("test process cleanup hook", () => {
	it("ignores non-Bash and non-test commands", () => {
		expect(
			evaluateTestProcessCleanup({
				toolName: "Read",
				toolInput: { command: "pnpm test" },
			}),
		).toEqual({ command: "pnpm test", matched: false, killedPids: [] });

		expect(
			evaluateTestProcessCleanup({
				toolName: "Bash",
				toolInput: { command: "pnpm build" },
			}),
		).toEqual({ command: "pnpm build", matched: false, killedPids: [] });
	});

	it("kills lingering vitest worker processes but skips current and parent pids", () => {
		const killed: number[] = [];
		const result = evaluateTestProcessCleanup(
			{
				toolName: "Bash",
				toolInput: { command: "pnpm test" },
			},
			{
				currentPid: 10,
				parentPid: 11,
				listPids: () => [10, 11, 12, 13],
				killPid: (pid) => {
					killed.push(pid);
					return pid !== 13;
				},
			},
		);

		expect(killed).toEqual([12, 13]);
		expect(result).toEqual({
			command: "pnpm test",
			matched: true,
			killedPids: [12],
		});
	});

	it("limits cleanup to processes from the hook cwd when cwd is available", () => {
		const killed: number[] = [];
		const result = evaluateTestProcessCleanup(
			{
				toolName: "Bash",
				toolInput: { command: "pnpm test" },
				cwd: "/repo-a",
			},
			{
				currentPid: 10,
				parentPid: 11,
				listProcesses: () => [
					{ pid: 10, cwd: "/repo-a" },
					{ pid: 12, cwd: "/repo-a" },
					{ pid: 13, cwd: "/repo-b" },
					{ pid: 14 },
				],
				killPid: (pid) => {
					killed.push(pid);
					return true;
				},
			},
		);

		expect(killed).toEqual([12]);
		expect(result).toEqual({
			command: "pnpm test",
			matched: true,
			killedPids: [12],
		});
	});
});
