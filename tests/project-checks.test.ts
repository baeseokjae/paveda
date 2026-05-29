import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runProjectChecks } from "../src/checks/project-checks.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("project checks", () => {
	it("runs executable .harness/checks scripts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-checks-"));
		tempDirs.push(cwd);
		const checksDir = join(cwd, ".harness", "checks");
		mkdirSync(checksDir, { recursive: true });
		const checkPath = join(checksDir, "playwright-setup.sh");
		writeFileSync(checkPath, "#!/bin/sh\necho PASS\n");
		chmodSync(checkPath, 0o755);

		expect(runProjectChecks({ cwd })).toMatchObject({
			ok: true,
			executions: [
				{
					name: "playwright-setup",
					status: 0,
					stdout: "PASS\n",
				},
			],
		});
	});

	it("filters by check name", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-checks-"));
		tempDirs.push(cwd);
		const checksDir = join(cwd, ".harness", "checks");
		mkdirSync(checksDir, { recursive: true });
		const first = join(checksDir, "playwright-setup.sh");
		const second = join(checksDir, "docs.sh");
		writeFileSync(first, "#!/bin/sh\necho playwright\n");
		writeFileSync(second, "#!/bin/sh\necho docs\n");
		chmodSync(first, 0o755);
		chmodSync(second, 0o755);

		const result = runProjectChecks({ cwd, name: "playwright-setup" });

		expect(result.executions.map((execution) => execution.name)).toEqual(["playwright-setup"]);
	});

	it("marks failed checks as not ok", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-checks-"));
		tempDirs.push(cwd);
		const checksDir = join(cwd, ".harness", "checks");
		mkdirSync(checksDir, { recursive: true });
		const checkPath = join(checksDir, "failing.sh");
		writeFileSync(checkPath, "#!/bin/sh\necho FAIL >&2\nexit 2\n");
		chmodSync(checkPath, 0o755);

		expect(runProjectChecks({ cwd })).toMatchObject({
			ok: false,
			executions: [{ name: "failing", status: 2, stderr: "FAIL\n" }],
		});
	});

	it("ignores symlinked check files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-checks-symlink-"));
		tempDirs.push(cwd);
		const checksDir = join(cwd, ".harness", "checks");
		const outsideDir = join(cwd, "outside");
		mkdirSync(checksDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		const outsideCheck = join(outsideDir, "outside.sh");
		writeFileSync(outsideCheck, "#!/bin/sh\necho outside\n");
		chmodSync(outsideCheck, 0o755);
		symlinkSync(outsideCheck, join(checksDir, "linked.sh"));

		expect(runProjectChecks({ cwd }).executions).toEqual([]);
	});

	it("does not follow a symlinked checks directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-project-checks-root-symlink-"));
		tempDirs.push(cwd);
		const harnessDir = join(cwd, ".harness");
		const outsideDir = join(cwd, "outside-checks");
		mkdirSync(harnessDir, { recursive: true });
		mkdirSync(outsideDir, { recursive: true });
		const outsideCheck = join(outsideDir, "outside.sh");
		writeFileSync(outsideCheck, "#!/bin/sh\necho outside\n");
		chmodSync(outsideCheck, 0o755);
		symlinkSync(outsideDir, join(harnessDir, "checks"));

		expect(runProjectChecks({ cwd })).toMatchObject({
			ok: true,
			executions: [],
		});
	});
});
