import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializePaveda } from "../src/init/index.js";
import { buildPack, inspectPack, installPack, verifyPack } from "../src/pack/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("shared pack packaging", () => {
	it("builds deterministic contract packs and verifies their checksums", () => {
		const project = initProject("paveda-pack-build-");
		writeFileSync(
			join(project, ".paveda", "evidence-policy.json"),
			`${JSON.stringify({ schemaVersion: 1, providers: [] }, null, 2)}\n`,
		);
		const outA = join(project, "pack-a.tgz");
		const outB = join(project, "pack-b.tgz");

		const builtA = buildPack({ cwd: project, out: outA });
		const builtB = buildPack({ cwd: project, out: outB });
		const inspected = inspectPack({ path: outA });
		const verified = verifyPack({ path: outA });

		expect(readFileSync(outA)).toEqual(readFileSync(outB));
		expect(builtA.manifest.entries.map((entry) => entry.path)).toEqual(
			builtB.manifest.entries.map((entry) => entry.path),
		);
		expect(inspected.ok).toBe(true);
		expect(verified).toMatchObject({
			ok: true,
			errors: [],
		});
		expect(builtA.manifest.entries.map((entry) => entry.path)).toEqual(
			expect.arrayContaining([
				"contracts/contract.json",
				"contracts/profiles/strict.json",
				"hosts/codex.json",
				"evidence-providers/evidence-policy.json",
			]),
		);
	});

	it("reports install diff before writing pack files", () => {
		const source = initProject("paveda-pack-source-");
		const target = tempDir("paveda-pack-target-");
		const out = join(source, "pack.tgz");
		buildPack({ cwd: source, out });

		const dryRun = installPack({ path: out, cwd: target });
		expect(dryRun).toMatchObject({
			ok: true,
			dryRun: true,
		});
		expect(dryRun.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					packPath: "contracts/contract.json",
					projectPath: join(target, ".paveda", "contract.json"),
					action: "create",
				}),
			]),
		);
		expect(existsSync(join(target, ".paveda", "contract.json"))).toBe(false);

		const written = installPack({ path: out, cwd: target, write: true });
		expect(written.ok).toBe(true);
		expect(existsSync(join(target, ".paveda", "contract.json"))).toBe(true);

		writeFileSync(join(target, ".paveda", "contract.json"), '{"drift":true}\n');
		const updateDiff = installPack({ path: out, cwd: target });
		expect(updateDiff.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					packPath: "contracts/contract.json",
					action: "update",
				}),
			]),
		);
	});
});

function initProject(prefix: string): string {
	const dir = tempDir(prefix);
	initializePaveda({ host: "codex", cwd: dir, skills: ["do"], write: true });
	return dir;
}

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}
