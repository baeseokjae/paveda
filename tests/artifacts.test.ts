import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ledger search and artifact retention", () => {
	it("searches evidence, decisions, and policy violations through FTS", () => {
		const { store, runId } = fixture("paveda-search-");
		try {
			const evidence = store.recordEvidence({
				runId,
				evidenceId: "checkout-security",
				kind: "security_scan",
				result: "pass",
				rationale: "checkout scan passed",
				ts: 120,
			});
			const decision = store.recordDecision({
				runId,
				decisionType: "risk.surface",
				decision: "payment",
				rationale: "checkout payment surface",
				ts: 130,
			});
			const violation = store.recordPolicyViolation({
				runId,
				policyId: "security-gate",
				severity: "block",
				message: "checkout security missing",
				blocked: true,
				ts: 140,
			});

			const results = store.searchLedger({ query: "checkout", runId });

			expect(results).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "evidence", refId: evidence.id }),
					expect.objectContaining({ type: "decision", refId: decision.id }),
					expect.objectContaining({ type: "policy_violation", refId: violation.id }),
				]),
			);
		} finally {
			store.close();
		}
	});

	it("compacts old non-release artifacts and preserves immutable release artifacts", () => {
		const { dir, store, runId } = fixture("paveda-artifact-compact-");
		try {
			const raw = store.writeArtifact({
				runId,
				kind: "stdout",
				fileName: "stdout.txt",
				content: "raw output\n",
				createdAt: 100,
			});
			const release = store.writeArtifact({
				runId,
				kind: "release-trace",
				fileName: "release.txt",
				content: "release output\n",
				metadata: {
					releaseRetention: {
						policy: "release",
						mode: "immutable",
						immutable: true,
					},
				},
				createdAt: 100,
			});
			const rawPath = join(dir, ".paveda", "artifacts", raw.relativePath);
			const releasePath = join(dir, ".paveda", "artifacts", release.relativePath);

			const dryRun = store.compactArtifacts({ runId, before: 200 });
			expect(dryRun).toMatchObject({
				ok: true,
				dryRun: true,
			});
			expect(dryRun.changes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ action: "eligible" }),
					expect.objectContaining({ action: "keep_release" }),
				]),
			);
			expect(existsSync(rawPath)).toBe(true);
			expect(existsSync(releasePath)).toBe(true);

			const compacted = store.compactArtifacts({ runId, before: 200, write: true, now: 300 });
			expect(compacted.changes).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ action: "compacted" }),
					expect.objectContaining({ action: "keep_release" }),
				]),
			);
			expect(existsSync(rawPath)).toBe(false);
			expect(existsSync(releasePath)).toBe(true);
			expect(
				store.listArtifacts(runId).find((artifact) => artifact.id === raw.id)?.metadata,
			).toEqual(
				expect.objectContaining({
					compacted: expect.objectContaining({
						at: 300,
						originalSha256: raw.sha256,
					}),
				}),
			);
		} finally {
			store.close();
		}
	});
});

function fixture(prefix: string): { dir: string; store: EventStore; runId: string } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	const store = new EventStore(join(dir, ".paveda", "ledger", "paveda.db"));
	const run = store.createRun({
		objective: "Exercise ledger search and artifact retention",
		profile: "release",
		host: "codex",
		context: { taskType: "code" },
		ts: 100,
	});
	return { dir, store, runId: run.runId };
}
