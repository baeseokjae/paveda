import type { EventRecord, EventStore } from "../store/index.js";

export interface PlanTask {
	id: string;
	title: string;
	files: string[];
	signatures: string[];
	acceptance: string;
	verification: string[];
	dependencies: string[];
	estimatedMinutes: number;
}

export interface GeneratedPlan {
	specRef: string;
	tasks: PlanTask[];
	totalEstimatedMinutes: number;
	dependencyGraph: Record<string, string[]>;
}

export interface RecordGeneratedPlanInput extends GeneratedPlan {
	sessionId: string;
	ts?: number;
}

export function recordGeneratedPlan(
	store: EventStore,
	input: RecordGeneratedPlanInput,
): EventRecord {
	const plan = validateGeneratedPlan(input);
	return store.append({
		sessionId: input.sessionId,
		ts: input.ts,
		type: "plan.generated",
		payload: {
			spec_ref: plan.specRef,
			tasks: plan.tasks.map((task) => ({
				id: task.id,
				title: task.title,
				files: task.files,
				signatures: task.signatures,
				acceptance: task.acceptance,
				verification: task.verification,
				dependencies: task.dependencies,
				estimated_minutes: task.estimatedMinutes,
			})),
			total_estimated_minutes: plan.totalEstimatedMinutes,
			dependency_graph: plan.dependencyGraph,
		},
	});
}

export function validateGeneratedPlan(plan: GeneratedPlan): GeneratedPlan {
	assertNonEmpty(plan.specRef, "specRef");
	if (plan.tasks.length === 0) {
		throw new Error("plan must contain at least one task");
	}
	const ids = new Set<string>();
	for (const task of plan.tasks) {
		validatePlanTask(task);
		if (ids.has(task.id)) {
			throw new Error(`duplicate plan task id: ${task.id}`);
		}
		ids.add(task.id);
	}
	for (const task of plan.tasks) {
		for (const dependency of task.dependencies) {
			if (!ids.has(dependency)) {
				throw new Error(`unknown dependency ${dependency} for task ${task.id}`);
			}
		}
	}
	for (const [taskId, dependencies] of Object.entries(plan.dependencyGraph)) {
		if (!ids.has(taskId)) {
			throw new Error(`dependency graph references unknown task: ${taskId}`);
		}
		for (const dependency of dependencies) {
			if (!ids.has(dependency)) {
				throw new Error(`dependency graph references unknown dependency: ${dependency}`);
			}
		}
	}
	const expectedTotal = plan.tasks.reduce((sum, task) => sum + task.estimatedMinutes, 0);
	if (plan.totalEstimatedMinutes !== expectedTotal) {
		throw new Error("totalEstimatedMinutes must equal the sum of task estimates");
	}
	return plan;
}

function validatePlanTask(task: PlanTask): void {
	assertNonEmpty(task.id, "task.id");
	assertNonEmpty(task.title, "task.title");
	assertNonEmpty(task.acceptance, "task.acceptance");
	assertNonEmptyArray(task.files, "task.files");
	assertNonEmptyArray(task.verification, "task.verification");
	if (!Number.isInteger(task.estimatedMinutes) || task.estimatedMinutes < 1) {
		throw new Error(`task ${task.id} estimatedMinutes must be a positive integer`);
	}
	if (task.estimatedMinutes > 5) {
		throw new Error(`task ${task.id} exceeds the 5 minute bite-sized limit`);
	}
}

function assertNonEmpty(value: string, label: string): void {
	if (value.trim().length === 0) {
		throw new Error(`${label} must be non-empty`);
	}
}

function assertNonEmptyArray(values: string[], label: string): void {
	if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
		throw new Error(`${label} must contain non-empty values`);
	}
}
