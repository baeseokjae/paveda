import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeMcpTool } from "../src/mcp/executor.js";
import { PAVEDA_MCP_TOOLS, handleMcpRequest } from "../src/mcp/server.js";
import {
	type PolicyBundle,
	createPolicyBundle,
	createPolicyBundleCacheEntry,
	signPolicyBundle,
	verifySignedPolicyBundleWithKeyring,
} from "../src/policy/index.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("MCP gateway", () => {
	it("lists Paveda MCP wrapper tools", () => {
		expect(PAVEDA_MCP_TOOLS.map((tool) => tool.name)).toEqual([
			"paveda.search",
			"paveda.read",
			"paveda.patch",
			"paveda.shell",
			"paveda.git",
			"paveda.test",
		]);
	});

	it("executes read and patch tools through EventStore lineage", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);
		writeFileSync(join(cwd, "README.md"), "# Project\n");

		const readResult = executeMcpTool({
			name: "paveda.read",
			arguments: { path: "README.md" },
			cwd,
			sessionId: "mcp-read",
			ts: 100,
			store,
		});
		const patchResult = executeMcpTool({
			name: "paveda.patch",
			arguments: { path: "notes.txt", content: "hello\n" },
			cwd,
			sessionId: "mcp-read",
			ts: 200,
			store,
		});

		expect(readResult).toMatchObject({
			blocked: false,
			output: {
				content: "# Project\n",
				truncated: false,
			},
		});
		expect(patchResult).toMatchObject({
			blocked: false,
			output: {
				written: true,
			},
		});
		expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello\n");
		expect(store.replay("mcp-read").map((event) => event.type)).toContain("tool.execute.before");

		store.close();
	});

	it("blocks destructive MCP shell commands before execution", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);

		const result = executeMcpTool({
			name: "paveda.shell",
			arguments: { command: "rm -rf /" },
			cwd,
			sessionId: "mcp-block",
			ts: 100,
			store,
		});

		expect(result).toMatchObject({
			blocked: true,
			error: expect.stringContaining("Recursive force removal"),
		});
		expect(store.policyLineage("mcp-block")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "D-003",
					action: "deny",
					enforced: true,
				}),
			]),
		);
		expect(store.replay("mcp-block").map((event) => event.type)).toContain("mcp.tool.blocked");

		store.close();
	});

	it("records verified policy source evidence for MCP policy decisions", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);
		const cachePath = writePolicyCacheEntry(cwd, ".harness/policy-cache.json");

		const result = executeMcpTool({
			name: "paveda.shell",
			arguments: { command: "rm -rf /" },
			cwd,
			sessionId: "mcp-policy-source",
			ts: 100,
			policyCachePath: ".harness/policy-cache.json",
			store,
		});

		expect(result).toMatchObject({
			blocked: true,
			policySource: {
				type: "bundle-cache",
				cachePath,
				keyId: "mcp-policy-key",
			},
			policyEvaluation: {
				policySource: {
					type: "bundle-cache",
					keyId: "mcp-policy-key",
				},
			},
		});
		expect(result.policyDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "D-003",
					evidence: expect.objectContaining({
						policySource: expect.objectContaining({
							type: "bundle-cache",
							keyId: "mcp-policy-key",
						}),
						details: expect.any(Object),
					}),
				}),
			]),
		);

		store.close();
	});

	it("fails closed when MCP policy cache cannot be verified", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);
		mkdirSync(join(cwd, ".harness"), { recursive: true });
		writeFileSync(join(cwd, ".harness", "policy-cache.json"), "{}\n");

		expect(() =>
			executeMcpTool({
				name: "paveda.shell",
				arguments: { command: "touch should-not-run" },
				cwd,
				sessionId: "mcp-invalid-policy-source",
				ts: 100,
				policyCachePath: ".harness/policy-cache.json",
				store,
			}),
		).toThrow("Policy cache is invalid:");
		expect(existsSync(join(cwd, "should-not-run"))).toBe(false);

		store.close();
	});

	it("blocks sensitive file writes through paveda.patch", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);

		const result = executeMcpTool({
			name: "paveda.patch",
			arguments: { path: ".env.local", content: "TOKEN=secret\n" },
			cwd,
			sessionId: "mcp-env",
			ts: 100,
			store,
		});

		expect(result).toMatchObject({
			blocked: true,
			error: expect.stringContaining("Editing .env files is blocked"),
		});
		expect(readFileSync(join(cwd, ".env.local"), { encoding: "utf8", flag: "a+" })).toBe("");

		store.close();
	});

	it("mediates git and test tools through policy and EventStore", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);

		executeMcpTool({
			name: "paveda.patch",
			arguments: { path: "src/index.ts", content: "export const value = 1;\n" },
			cwd,
			sessionId: "mcp-git-test",
			ts: 100,
			store,
		});

		const gitResult = executeMcpTool({
			name: "paveda.git",
			arguments: { args: ["commit", "-m", "change"] },
			cwd,
			sessionId: "mcp-git-test",
			ts: 200,
			store,
		});
		const testResult = executeMcpTool({
			name: "paveda.test",
			arguments: { command: "node -e \"process.stdout.write('ok')\"" },
			cwd,
			sessionId: "mcp-test",
			ts: 300,
			store,
		});

		expect(gitResult).toMatchObject({
			blocked: true,
			error: expect.stringContaining("verification evidence is recorded"),
		});
		expect(gitResult.policyDecisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ruleId: "W-003",
					action: "deny",
					enforced: true,
				}),
			]),
		);
		expect(testResult).toMatchObject({
			blocked: false,
			output: { stdout: "ok" },
		});
		expect(store.replay("mcp-test").map((event) => event.type)).toEqual([
			"tool.execute.before",
			"tool.execute.after",
		]);

		store.close();
	});

	it("handles initialize, tools/list, and tools/call JSON-RPC requests", () => {
		const cwd = makeTempDir();
		const store = openTempStore(cwd);
		writeFileSync(join(cwd, "README.md"), "# Project\n");

		expect(
			handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }, { cwd, store }),
		).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				capabilities: { tools: {} },
				serverInfo: { name: "paveda" },
			},
		});
		expect(
			handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { cwd, store }),
		).toMatchObject({
			result: {
				tools: expect.arrayContaining([expect.objectContaining({ name: "paveda.read" })]),
			},
		});
		expect(
			handleMcpRequest(
				{
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
					params: {
						name: "paveda.read",
						arguments: { path: "README.md" },
					},
				},
				{ cwd, store },
			),
		).toMatchObject({
			result: {
				isError: false,
				content: [expect.objectContaining({ type: "text" })],
			},
		});

		store.close();
	});
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "paveda-mcp-"));
	tempDirs.push(dir);
	return dir;
}

function openTempStore(cwd: string): EventStore {
	return new EventStore(join(cwd, ".harness", "store.db"));
}

function writePolicyCacheEntry(
	cwd: string,
	relativePath: string,
	transformBundle: (bundle: PolicyBundle) => PolicyBundle = (bundle) => bundle,
): string {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
	const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
	const bundle = transformBundle(
		createPolicyBundle({
			issuer: "mcp-policy-source-test",
			generatedAt: "2026-06-01T00:00:00.000Z",
		}),
	);
	const signedBundle = signPolicyBundle(bundle, { privateKeyPem, keyId: "mcp-policy-key" });
	const verification = verifySignedPolicyBundleWithKeyring(signedBundle, {
		keys: [{ keyId: "mcp-policy-key", publicKeyPem }],
	});
	const cacheEntry = createPolicyBundleCacheEntry(signedBundle, verification, {
		source: "https://policy.example.invalid/mcp-policy.signed.json",
		cachedAt: "2026-06-01T00:01:00.000Z",
	});
	const path = join(cwd, relativePath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cacheEntry, null, 2)}\n`);
	return path;
}
