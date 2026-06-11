import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "../src/setup/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("setup", () => {
	it("detects host binaries from PATH and returns a dry-run plan without writing files", () => {
		const cwd = tempDir("paveda-setup-dry-");
		const bin = writeExecutable(cwd, "codex");

		const result = runSetup({
			cwd,
			env: { PATH: bin },
		});

		expect(result).toMatchObject({
			status: "partial",
			dryRun: true,
			mode: "lite",
			detectedHosts: ["codex"],
			installedHosts: [],
			nextCommand: expect.stringContaining("paveda setup --host codex"),
		});
		expect(result.hosts[0]).toMatchObject({
			host: "codex",
			detected: true,
			installed: false,
		});
		expect(existsSync(join(cwd, ".paveda"))).toBe(false);
		expect(existsSync(join(cwd, ".codex"))).toBe(false);
	});

	it("writes selected host setup and runs doctor/runtime smoke", () => {
		const cwd = tempDir("paveda-setup-write-");
		const bin = writeExecutable(cwd, "codex");

		const result = runSetup({
			cwd,
			host: "codex",
			mode: "managed",
			write: true,
			env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
		});

		expect(result.status).toBe("ready");
		expect(result.mode).toBe("managed");
		expect(result.installedHosts).toEqual(["codex"]);
		expect(result.doctor?.ok).toBe(true);
		expect(result.runtimeSmoke?.ok).toBe(true);
		expect(result.nextCommand).toContain("paveda do --host codex");
		expect(existsSync(join(cwd, ".paveda", "manifest.json"))).toBe(true);
		expect(existsSync(join(cwd, ".codex", "skills", "do", "SKILL.md"))).toBe(true);
	});
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeExecutable(root: string, name: string): string {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const path = join(bin, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return bin;
}
