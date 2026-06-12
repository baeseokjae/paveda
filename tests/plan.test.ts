import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordGeneratedPlan, validateGeneratedPlan } from "../src/plan/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("plan generated contract", () => {
	it("records plan.generated with bite-sized tasks", () => {
		const store = openTempStore();
		const event = recordGeneratedPlan(store, {
			sessionId: "plan-session",
			specRef: "spec:abc123",
			tasks: [
				{
					id: "task-1",
					title: "Add Task type definition",
					files: ["src/types/task.ts"],
					signatures: ["export interface Task"],
					acceptance: "Task interface compiles with required fields",
					verification: ["pnpm typecheck"],
					dependencies: [],
					estimatedMinutes: 3,
				},
			],
			totalEstimatedMinutes: 3,
			dependencyGraph: { "task-1": [] },
			ts: 100,
		});

		expect(event).toMatchObject({
			type: "plan.generated",
			payload: {
				spec_ref: "spec:abc123",
				total_estimated_minutes: 3,
				dependency_graph: { "task-1": [] },
				tasks: [
					expect.objectContaining({
						id: "task-1",
						estimated_minutes: 3,
						verification: ["pnpm typecheck"],
					}),
				],
			},
		});
		expect(store.replay("plan-session")).toHaveLength(1);
		store.close();
	});

	it("rejects oversized and invalid dependency tasks", () => {
		expect(() =>
			validateGeneratedPlan({
				specRef: "spec:abc123",
				tasks: [
					{
						id: "task-1",
						title: "Too large",
						files: ["src/foo.ts"],
						signatures: [],
						acceptance: "works",
						verification: ["pnpm test"],
						dependencies: ["missing"],
						estimatedMinutes: 6,
					},
				],
				totalEstimatedMinutes: 6,
				dependencyGraph: { "task-1": ["missing"] },
			}),
		).toThrow("5 minute bite-sized limit");
	});
});

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-plan-"));
	tempDirs.push(dir);
	return new EventStore(join(dir, "store.db"));
}
