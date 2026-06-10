import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePaveda } from "../src/init/index.js";
import {
	approveProjectionOverride,
	checkProjectionStatus,
	diffProjections,
	importProjectionDrift,
	regenerateProjections,
} from "../src/projection/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("projection index and drift handling", () => {
	it("initializes the .paveda layout and records generated projection hashes", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-init-"));
		tempDirs.push(dir);

		const result = initializePaveda({
			host: "codex",
			cwd: dir,
			skills: ["do"],
			write: true,
		});

		expect(result.paveda.projectionStatus.ok).toBe(true);
		expect(existsSync(join(dir, ".paveda", "manifest.json"))).toBe(true);
		expect(existsSync(join(dir, ".paveda", "projections", "index.json"))).toBe(true);
		expect(existsSync(join(dir, ".paveda", "projections", "snapshots", "codex", "AGENTS.md"))).toBe(
			true,
		);

		const index = readJson(join(dir, ".paveda", "projections", "index.json")) as {
			entries: Array<{ host: string; projectionPath: string; projectionKind: string }>;
		};
		expect(index.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					host: "codex",
					projectionPath: "AGENTS.md",
					projectionKind: "instruction",
				}),
				expect.objectContaining({
					host: "codex",
					projectionPath: ".codex/skills/do/SKILL.md",
					projectionKind: "skill",
				}),
			]),
		);
	});

	it("detects projection drift and returns a textual diff", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-drift-"));
		tempDirs.push(dir);
		initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
		writeFileSync(
			join(dir, "AGENTS.md"),
			`${readFileSync(join(dir, "AGENTS.md"), "utf8")}\nlocal edit\n`,
		);

		const status = checkProjectionStatus({ cwd: dir, host: "codex", path: "AGENTS.md" });
		expect(status.ok).toBe(false);
		expect(status.entries[0]).toMatchObject({
			projectionPath: "AGENTS.md",
			state: "drifted",
		});

		const diff = diffProjections({ cwd: dir, host: "codex", path: "AGENTS.md" });
		expect(diff.ok).toBe(false);
		expect(diff.diffs[0]?.diff.join("\n")).toContain("+ local edit");
		expect(diff.recoveryCommands.join("\n")).toContain("projection regenerate");
	});

	it("imports an explicit projection edit into .paveda and marks the projection clean", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-import-"));
		tempDirs.push(dir);
		initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
		writeFileSync(join(dir, "AGENTS.md"), "imported instructions\n");

		const result = importProjectionDrift({
			cwd: dir,
			host: "codex",
			path: "AGENTS.md",
			reason: "Project instructions changed intentionally",
			write: true,
		});

		expect(readFileSync(result.importPath, "utf8")).toBe("imported instructions\n");
		expect(result.status.ok).toBe(true);
		expect(result.status.entries[0]).toMatchObject({
			state: "clean",
			importedSourcePath: ".paveda/hosts/codex/imports/AGENTS.md",
		});
	});

	it("regenerates host files from packaged Paveda assets", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-regenerate-"));
		tempDirs.push(dir);
		initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
		writeFileSync(join(dir, "AGENTS.md"), "local drift\n");

		const result = regenerateProjections({
			cwd: dir,
			host: "codex",
			skills: ["do"],
			write: true,
		});

		expect(result.status.ok).toBe(true);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
			"Workflow skills: `.codex/skills`",
		);
		expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toBe("local drift\n");
	});

	it("approves drift only as an audited override and records a ledger decision", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-override-"));
		tempDirs.push(dir);
		initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
		writeFileSync(join(dir, "AGENTS.md"), "temporary override\n");

		const result = approveProjectionOverride({
			cwd: dir,
			host: "codex",
			path: "AGENTS.md",
			reason: "Temporary host-specific instructions during rollout",
			actor: "test",
			scope: "project",
			expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			compensatingControl: "Review before next projection regenerate",
			write: true,
		});

		expect(result.status.ok).toBe(true);
		expect(result.status.entries[0]).toMatchObject({
			state: "overridden",
			manualOverrideId: result.override.id,
		});
		expect(result.override.ledgerDecisionId).toBeGreaterThan(0);
		expect(existsSync(join(dir, ".paveda", "ledger", "paveda.db"))).toBe(true);
	});

	it("blocks release profile projection execution in MVP", () => {
		const dir = mkdtempSync(join(tmpdir(), "paveda-projection-release-"));
		tempDirs.push(dir);
		initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });

		expect(() =>
			regenerateProjections({
				cwd: dir,
				host: "codex",
				profile: "release",
				write: true,
			}),
		).toThrow("not_supported_in_mvp");
	});
});

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}
