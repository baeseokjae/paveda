import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTextFileSafely } from "../src/fs-safety.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("filesystem write safety", () => {
	it("writes regular output files", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-fs-safety-"));
		tempDirs.push(dir);
		const path = join(dir, "report.md");

		writeTextFileSafely(path, "# Report\n");

		expect(readFileSync(path, "utf8")).toBe("# Report\n");
	});

	it("refuses to write through a symlinked output file", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-fs-safety-file-symlink-"));
		tempDirs.push(dir);
		const externalPath = join(dir, "external.md");
		const linkedPath = join(dir, "linked.md");
		writeFileSync(externalPath, "external\n");
		symlinkSync(externalPath, linkedPath);

		expect(() => writeTextFileSafely(linkedPath, "changed\n")).toThrow(
			"Output path must not use symlinks",
		);
		expect(readFileSync(externalPath, "utf8")).toBe("external\n");
	});

	it("refuses to write below a symlinked output directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-fs-safety-dir-symlink-"));
		tempDirs.push(dir);
		const externalDir = join(dir, "external");
		const linkedDir = join(dir, "linked");
		mkdirSync(externalDir);
		symlinkSync(externalDir, linkedDir);

		expect(() => writeTextFileSafely(join(linkedDir, "report.md"), "changed\n")).toThrow(
			"Output path must not use symlinks",
		);
	});
});
