import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProjectHooks } from "../src/hooks/project-hooks.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("project hooks", () => {
	it("runs executable .harness/hooks scripts with the raw Claude Code payload", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-hooks-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const hookPath = join(hooksDir, "docs-final-check.sh");

		writeFileSync(
			hookPath,
			[
				"#!/bin/sh",
				"INPUT=$(cat)",
				'case "$INPUT" in',
				'  *"Stop"*) echo \'{"decision":"block","reason":"docs needed"}\' ;;',
				"  *) exit 0 ;;",
				"esac",
			].join("\n"),
		);
		chmodSync(hookPath, 0o755);

		const result = runProjectHooks({
			cwd,
			raw: { hook_event_name: "Stop", session_id: "session-1" },
		});

		expect(result.executions).toHaveLength(1);
		expect(result.executions[0]).toMatchObject({
			name: "docs-final-check.sh",
			status: 0,
			response: { decision: "block", reason: "docs needed" },
		});
	});

	it("runs hooks from matching event and tool directories", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-hooks-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		const eventDir = join(hooksDir, "PostToolUse");
		const toolDir = join(eventDir, "Edit");
		mkdirSync(toolDir, { recursive: true });
		mkdirSync(join(hooksDir, "Stop"), { recursive: true });
		const eventHook = join(eventDir, "check-docs-needed.sh");
		const toolHook = join(toolDir, "edit-only.sh");
		const stopHook = join(hooksDir, "Stop", "docs-final-check.sh");
		writeFileSync(eventHook, "#!/bin/sh\necho event\n");
		writeFileSync(toolHook, "#!/bin/sh\necho tool\n");
		writeFileSync(stopHook, "#!/bin/sh\necho stop\n");
		chmodSync(eventHook, 0o755);
		chmodSync(toolHook, 0o755);
		chmodSync(stopHook, 0o755);

		const result = runProjectHooks({
			cwd,
			raw: {
				hook_event_name: "PostToolUse",
				session_id: "session-1",
				tool_name: "Edit",
			},
		});

		expect(result.executions.map((item) => item.name)).toEqual([
			"check-docs-needed.sh",
			"edit-only.sh",
		]);
	});

	it("ignores non-executable files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-hooks-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(join(hooksDir, "README.md"), "not a hook");

		expect(runProjectHooks({ cwd }).executions).toEqual([]);
	});

	it("does not treat event or tool names as path traversal segments", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-hooks-traversal-"));
		tempDirs.push(cwd);
		const harnessDir = join(cwd, ".harness");
		const hooksDir = join(harnessDir, "hooks");
		const checksDir = join(harnessDir, "checks");
		mkdirSync(hooksDir, { recursive: true });
		mkdirSync(checksDir, { recursive: true });
		const escapedEventHook = join(harnessDir, "escaped-event.sh");
		const escapedToolHook = join(checksDir, "escaped-tool.sh");
		writeFileSync(escapedEventHook, "#!/bin/sh\necho escaped event\n");
		writeFileSync(escapedToolHook, "#!/bin/sh\necho escaped tool\n");
		chmodSync(escapedEventHook, 0o755);
		chmodSync(escapedToolHook, 0o755);

		expect(
			runProjectHooks({
				cwd,
				raw: { hook_event_name: "..", session_id: "session-1" },
			}).executions,
		).toEqual([]);
		expect(
			runProjectHooks({
				cwd,
				raw: {
					hook_event_name: "PostToolUse",
					session_id: "session-1",
					tool_name: "../../checks",
				},
			}).executions,
		).toEqual([]);
	});

	it("ignores symlinked hook files and directories", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-hooks-symlink-"));
		tempDirs.push(cwd);
		const hooksDir = join(cwd, ".harness", "hooks");
		const outsideDir = join(cwd, "outside");
		mkdirSync(hooksDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		const outsideHook = join(outsideDir, "outside.sh");
		writeFileSync(outsideHook, "#!/bin/sh\necho outside\n");
		chmodSync(outsideHook, 0o755);
		symlinkSync(outsideHook, join(hooksDir, "linked.sh"));
		symlinkSync(outsideDir, join(hooksDir, "LinkedEvent"));

		const result = runProjectHooks({
			cwd,
			raw: { hook_event_name: "LinkedEvent", session_id: "session-1" },
		});

		expect(result.executions).toEqual([]);
	});
});
