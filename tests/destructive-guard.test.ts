import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PavedaConfig } from "../src/core/index.js";
import { dispatchHookEvent } from "../src/hook-runtime/index.js";
import { evaluateDestructiveGuard } from "../src/hooks/destructive-guard.js";
import { EventStore } from "../src/store/index.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("destructive guard", () => {
	it("denies secret writes to .env files", () => {
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "echo API_KEY=secret >> .env" },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-001",
		});
	});

	it("denies direct .env writes even without secret-looking keys", () => {
		for (const command of [
			"echo FEATURE_FLAG=true >> .env.local",
			"printf 'DEBUG=1' > .env",
			"printf 'DEBUG=1' | tee -a .env.development",
		]) {
			expect(
				evaluateDestructiveGuard({
					toolName: "Bash",
					toolInput: { command },
				}),
			).toMatchObject({
				decision: "deny",
				ruleId: "D-001",
			});
		}
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "cp .env.example .env.example.backup" },
			}),
		).toMatchObject({
			decision: "allow",
		});
	});

	it("denies destructive SQL commands", () => {
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "mysql -e 'DROP TABLE users'" },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-002",
		});
	});

	it("denies Bash commands that write secret key files", () => {
		for (const command of [
			"openssl genrsa -out private.key 4096",
			"ssh-keygen -t ed25519 -f id_ed25519 -N ''",
			"printf '%s' secret > cert.pem",
			"printf '%s' secret | tee -a secrets/client.p12",
		]) {
			expect(
				evaluateDestructiveGuard({
					toolName: "Bash",
					toolInput: { command },
				}),
			).toMatchObject({
				decision: "deny",
				ruleId: "D-005",
			});
		}
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "cat cert.pem" },
			}),
		).toMatchObject({
			decision: "allow",
		});
	});

	it("warns for broad wildcard rm commands outside test/temp paths", () => {
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "rm -rf src/* apps/* packages/* docs/* scripts/* config/*" },
			}),
		).toMatchObject({
			decision: "warn",
			ruleId: "D-003",
		});
	});

	it("denies recursive force removal of high-risk targets", () => {
		for (const command of ["rm -rf /", "sudo rm -rf .", 'rm -rf -- "$HOME"', "rm -rf ../*"]) {
			expect(
				evaluateDestructiveGuard({
					toolName: "Bash",
					toolInput: { command },
				}),
			).toMatchObject({
				decision: "deny",
				ruleId: "D-003",
			});
		}
		expect(
			evaluateDestructiveGuard({
				toolName: "Bash",
				toolInput: { command: "rm -rf /tmp/paveda-test-output" },
			}),
		).toMatchObject({
			decision: "allow",
		});
	});

	it("denies .env edits and secret file creation", () => {
		expect(
			evaluateDestructiveGuard({
				toolName: "Edit",
				toolInput: { file_path: "/repo/.env.local" },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-004",
		});
		expect(
			evaluateDestructiveGuard({
				toolName: "Write",
				toolInput: { file_path: "/repo/cert.pem" },
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-005",
		});
	});

	it("denies risky apply_patch file mutations", () => {
		expect(
			evaluateDestructiveGuard({
				toolName: "apply_patch",
				toolInput: {
					patch: [
						"*** Begin Patch",
						"*** Update File: .env.local",
						"+TOKEN=secret",
						"*** End Patch",
					].join("\n"),
				},
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-004",
		});
		expect(
			evaluateDestructiveGuard({
				toolName: "apply_patch",
				toolInput: {
					patch: [
						"diff --git a/certs/client.pem b/certs/client.pem",
						"--- a/certs/client.pem",
						"+++ b/certs/client.pem",
						"@@",
						"+secret",
					].join("\n"),
				},
			}),
		).toMatchObject({
			decision: "deny",
			ruleId: "D-005",
		});
	});

	it("warns for world writable permissions", () => {
		for (const command of [
			"chmod 777 scripts/deploy.sh",
			"chmod 666 secrets.txt",
			"chmod -R a+w uploads",
			"chmod +w shared",
			"chmod o=rw shared",
		]) {
			expect(
				evaluateDestructiveGuard({
					toolName: "Bash",
					toolInput: { command },
				}),
			).toMatchObject({
				decision: "warn",
				ruleId: "D-006",
			});
		}
		for (const command of ["chmod 755 scripts/deploy.sh", "chmod u+w local.txt"]) {
			expect(
				evaluateDestructiveGuard({
					toolName: "Bash",
					toolInput: { command },
				}),
			).toMatchObject({
				decision: "allow",
			});
		}
	});

	it("records destructive guard evaluation through runtime dispatch", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-1",
			lifecycle: "tool.execute.before",
			matcher: "Bash",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Bash",
				raw: {
					tool_input: { command: "truncate table sessions" },
				},
			},
			config: config(),
		});

		expect(result.destructiveGuard).toMatchObject({
			decision: "deny",
			ruleId: "D-002",
		});
		expect(
			store.replay("session-1").find((event) => event.type === "destructive.guard.evaluated"),
		).toMatchObject({
			type: "destructive.guard.evaluated",
			payload: {
				decision: "deny",
				ruleId: "D-002",
			},
		});

		store.close();
	});

	it("runs destructive guard as a companion for file mutation hooks", () => {
		const store = openTempStore();

		const result = dispatchHookEvent(store, {
			sessionId: "session-edit-env",
			lifecycle: "tool.execute.before",
			matcher: "Edit",
			ts: 100,
			payload: {
				host: "claude-code",
				tool: "Edit",
				raw: {
					tool_input: { file_path: "/repo/.env.local" },
				},
			},
			config: config(),
		});

		expect(result.hook.name).toBe("harness.blast.check");
		expect(result.destructiveGuard).toMatchObject({
			decision: "deny",
			ruleId: "D-004",
		});
		expect(
			store
				.replay("session-edit-env")
				.some((event) => event.type === "destructive.guard.evaluated"),
		).toBe(true);

		store.close();
	});
});

function config(): PavedaConfig {
	return {
		hookProfile: "standard",
		disabledHooks: [],
		projectHooks: false,
		sessionStartContext: false,
		sessionStartMaxChars: 8000,
		costGuardMaxMinutes: 120,
		costGuardAgentWarningThreshold: 5,
		costGuardAgentCompactInterval: 3,
	};
}

function openTempStore(): EventStore {
	const dir = mkdtempSync(join(tmpdir(), "paveda-destructive-guard-"));
	tempDirs.push(dir);

	return new EventStore(join(dir, "store.db"));
}
