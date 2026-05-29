import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAdoptionReport, runAdoptionReport } from "../src/checks/adoption-report.js";
import { type HostSkillBundleTarget, installHostSkillBundle } from "../src/host-bundles/index.js";
import { initializePaveda } from "../src/init/index.js";

const tempDirs: string[] = [];
const ADOPTION_HOSTS: HostSkillBundleTarget[] = ["harness", "claude-code", "codex", "pi", "hermes"];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("adoption report", () => {
	it.each(ADOPTION_HOSTS)(
		"summarizes installed %s readiness without writing runtime smoke by default",
		(host) => {
			const cwd = mkdtempSync(join(tmpdir(), "paveda-adoption-report-"));
			tempDirs.push(cwd);
			initializePaveda({ host, cwd, write: true });

			const result = runAdoptionReport({ host, cwd });

			expect(result.ok).toBe(true);
			expect(result.doctor.ok).toBe(true);
			expect(result.doSkill).toMatchObject({
				name: "do",
				selected: { scope: "project" },
				routerEnabled: true,
			});
			expect(result.route).toMatchObject({
				enabled: true,
				blocked: true,
				reason: "blocked:ambiguity",
			});
			expect(result.runtimeSmoke).toMatchObject({
				status: "skipped",
			});
			expect(existsSync(join(cwd, ".harness", "store.db"))).toBe(false);
			expect(formatAdoptionReport(result)).toContain("SKIPPED runtime-smoke");
		},
	);

	it.each(ADOPTION_HOSTS)(
		"runs runtime smoke for installed %s when explicitly requested",
		(host) => {
			const cwd = mkdtempSync(join(tmpdir(), `paveda-adoption-report-${host}-runtime-`));
			tempDirs.push(cwd);
			initializePaveda({ host, cwd, write: true });
			const sessionId = `adoption-report-${host}-runtime-smoke`;

			const result = runAdoptionReport({
				host,
				cwd,
				runtimeSmoke: true,
				dbPath: join(cwd, ".harness", `adoption-report-${host}-smoke.db`),
				sessionId,
			});

			expect(result.ok).toBe(true);
			expect(result.runtimeSmoke).toMatchObject({
				status: "pass",
				result: {
					sessionId,
					eventCount: 9,
					summary: {
						status: "completed",
						toolCalls: 1,
					},
				},
			});
		},
	);

	it("fails when host bundle adoption is incomplete", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-adoption-report-missing-"));
		tempDirs.push(cwd);

		const result = runAdoptionReport({ host: "codex", cwd });
		const formatted = formatAdoptionReport(result);

		expect(result.ok).toBe(false);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "doctor",
					status: "fail",
					message: expect.stringContaining("host-skill-root"),
					details: {
						failures: expect.arrayContaining([
							expect.objectContaining({
								name: "host-skill-root",
								message: expect.stringContaining("Host skill root is missing."),
								path: join(cwd, ".codex", "skills"),
								recovery: {
									command: `paveda skills install-bundle --host codex --cwd ${cwd} --write`,
									description: expect.any(String),
								},
							}),
							expect.objectContaining({
								name: "host-instruction-file",
								message: expect.stringContaining("Host instruction file is missing."),
								path: join(cwd, "AGENTS.md"),
							}),
						]),
					},
				}),
				expect.objectContaining({ name: "do-skill", status: "fail" }),
				expect.objectContaining({ name: "do-router", status: "fail" }),
				expect.objectContaining({ name: "route-do", status: "fail" }),
			]),
		);
		expect(formatted).toContain("FAIL doctor: Host bundle readiness checks failed");
		expect(formatted).toContain("host-skill-root: Host skill root is missing.");
		expect(formatted).toContain(`path: ${join(cwd, ".codex", "skills")}`);
		expect(formatted).toContain(
			`recovery: paveda skills install-bundle --host codex --cwd ${cwd} --write`,
		);
		expect(existsSync(join(cwd, ".harness", "store.db"))).toBe(false);
	});

	it("uses a provided CLI command for doctor recovery commands", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-adoption-report-cli-command-"));
		tempDirs.push(cwd);

		const result = runAdoptionReport({
			host: "codex",
			cwd,
			cliCommand: "node /opt/paveda/dist/cli.js",
		});

		const doctor = result.checks.find((check) => check.name === "doctor");
		expect(doctor).toMatchObject({ status: "fail" });
		expect((doctor?.details as { failures?: unknown[] } | undefined)?.failures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "host-skill-root",
					recovery: expect.objectContaining({
						command: `node /opt/paveda/dist/cli.js skills install-bundle --host codex --cwd ${cwd} --write`,
					}),
				}),
			]),
		);
	});

	it("summarizes a host bundle installed to a custom target root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "paveda-adoption-report-custom-root-"));
		tempDirs.push(cwd);

		installHostSkillBundle({
			host: "codex",
			cwd,
			targetRoot: "vendor/codex-skills",
			skills: ["do"],
			write: true,
		});

		const result = runAdoptionReport({
			host: "codex",
			cwd,
			targetRoot: "vendor/codex-skills",
		});

		expect(result.ok).toBe(true);
		expect(result.targetRoot).toBe(join(cwd, "vendor", "codex-skills"));
		expect(result.doctor.ok).toBe(true);
		expect(result.doSkill).toMatchObject({
			name: "do",
			selected: {
				scope: "project",
				path: join(cwd, "vendor", "codex-skills", "do", "SKILL.md"),
			},
			routerEnabled: true,
		});
		expect(result.route).toMatchObject({
			enabled: true,
			blocked: true,
			reason: "blocked:ambiguity",
		});
		expect(formatAdoptionReport(result)).toContain(
			`targetRoot: ${join(cwd, "vendor", "codex-skills")}`,
		);
	});
});
