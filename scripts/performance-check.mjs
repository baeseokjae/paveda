#!/usr/bin/env node

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const thresholds = {
	eventStoreAppendMs: 5,
	hookDispatchMs: 50,
	skillLoadMs: 200,
};

const samples = {
	eventStoreAppend: 500,
	hookDispatch: 100,
	skillLoad: 20,
};

const dist = await importBuiltDist();
const checks = [
	checkEventStoreAppend(dist),
	checkMinimalHookDispatch(dist),
	checkSkillLoadColdStart(dist),
];

const failures = checks.filter((check) => check.averageMs > check.thresholdMs);
if (failures.length > 0) {
	console.error("performance check failed:");
	for (const failure of failures) {
		console.error(
			`- ${failure.name}: ${formatMs(failure.averageMs)} average > ${formatMs(
				failure.thresholdMs,
			)} threshold`,
		);
	}
	process.exit(1);
}

for (const check of checks) {
	console.log(
		`${check.name}: ${formatMs(check.averageMs)} average <= ${formatMs(check.thresholdMs)}`,
	);
}

async function importBuiltDist() {
	try {
		return await import(new URL("../dist/index.js", import.meta.url).href);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not import dist/index.js. Run pnpm build first. ${message}`);
	}
}

function checkEventStoreAppend(dist) {
	const store = new dist.store.EventStore(":memory:");
	try {
		const averageMs = averageDuration(samples.eventStoreAppend, (index) => {
			store.append({
				sessionId: "performance-event-store",
				type: "tool.execute.before",
				ts: index,
				payload: { tool: "Read", index },
			});
		});

		return {
			name: "EventStore append latency",
			averageMs,
			thresholdMs: thresholds.eventStoreAppendMs,
		};
	} finally {
		store.close();
	}
}

function checkMinimalHookDispatch(dist) {
	const store = new dist.store.EventStore(":memory:");
	const config = {
		...dist.core.loadConfig({
			PAVEDA_HOOK_PROFILE: "minimal",
			PAVEDA_SESSION_START_CONTEXT: "off",
		}),
		projectHooks: false,
	};
	try {
		const averageMs = averageDuration(samples.hookDispatch, (index) => {
			const result = dist.hookRuntime.dispatchHookEvent(store, {
				sessionId: `performance-hook-${index}`,
				lifecycle: "tool.execute.before",
				matcher: "Bash",
				ts: index,
				config,
				projectHooks: false,
				payload: {
					tool_name: "Bash",
					tool_input: { command: "pnpm test" },
				},
			});
			if (!result.dispatched) {
				throw new Error("minimal hook dispatch did not dispatch");
			}
		});

		return {
			name: "Minimal hook dispatch overhead",
			averageMs,
			thresholdMs: thresholds.hookDispatchMs,
		};
	} finally {
		store.close();
	}
}

function checkSkillLoadColdStart(dist) {
	const cwd = mkdtempSync(join(tmpdir(), "paveda-performance-skills-"));
	const root = join(cwd, ".harness", "skills");
	try {
		for (let index = 0; index < 10; index += 1) {
			const skillDir = join(root, `skill-${index}`);
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				[
					"---",
					`name: skill-${index}`,
					`description: Performance smoke skill ${index}`,
					"model: standard",
					"---",
					"",
					`# Skill ${index}`,
				].join("\n"),
			);
		}

		const averageMs = averageDuration(samples.skillLoad, () => {
			const skills = dist.skillLoader.loadSkills({
				cwd,
				projectRoots: [root],
				userRoots: [],
				builtinRoots: [],
			});
			if (skills.length !== 10) {
				throw new Error(`expected 10 loaded skills, got ${skills.length}`);
			}
		});

		return {
			name: "Skill loading cold start",
			averageMs,
			thresholdMs: thresholds.skillLoadMs,
		};
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

function averageDuration(iterations, fn) {
	const start = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		fn(index);
	}
	return (performance.now() - start) / iterations;
}

function formatMs(value) {
	return `${value.toFixed(3)}ms`;
}
