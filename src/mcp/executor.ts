import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertPathDoesNotUseSymlinks, assertWritePathIsSafe } from "../fs-safety.js";
import { evaluateBlastCheck } from "../hooks/blast-check.js";
import { evaluateDestructiveGuard } from "../hooks/destructive-guard.js";
import { evaluateToolingEnforce } from "../hooks/tooling-enforce.js";
import {
	PolicyEngine,
	type PolicyEvaluation,
	type PolicySourceResults,
	normalizeAgentEvent,
	projectWorkflowState,
} from "../policy/index.js";
import type { EventRecord, EventStore, PolicyDecisionRecord } from "../store/index.js";
import { semanticSearchLedger } from "../store/semantic-search.js";

export type PavedaMcpToolName =
	| "paveda.search"
	| "paveda.search_semantic"
	| "paveda.read"
	| "paveda.patch"
	| "paveda.shell"
	| "paveda.git"
	| "paveda.test";

export interface ExecuteMcpToolOptions {
	name: string;
	arguments?: unknown;
	cwd?: string;
	sessionId?: string;
	ts?: number;
	store: EventStore;
}

export interface McpToolExecutionResult {
	tool: string;
	sessionId: string;
	cwd: string;
	blocked: boolean;
	output?: unknown;
	error?: string;
	events: EventRecord[];
	policyEvaluation: PolicyEvaluation;
	policyDecisions: PolicyDecisionRecord[];
}

interface PreparedMcpTool {
	name: PavedaMcpToolName;
	toolName: string;
	toolInput: Record<string, unknown>;
	run(): unknown;
}

const POLICY_ENGINE = new PolicyEngine();
const DEFAULT_SESSION_ID = "mcp-session";

export function executeMcpTool(options: ExecuteMcpToolOptions): McpToolExecutionResult {
	const toolName = parseMcpToolName(options.name);
	const cwd = resolve(options.cwd ?? process.cwd());
	const sessionId = options.sessionId ?? DEFAULT_SESSION_ID;
	const ts = options.ts ?? Date.now();
	const prepared = prepareMcpTool(toolName, options.arguments, cwd, options.store);
	const payload = {
		host: "mcp",
		cwd,
		tool: prepared.toolName,
		raw: {
			tool_name: prepared.toolName,
			tool_input: prepared.toolInput,
			mcp_tool_name: prepared.name,
		},
	};
	const agentEvent = normalizeAgentEvent({
		sessionId,
		lifecycle: "tool.execute.before",
		matcher: prepared.toolName,
		payload,
		ts,
	});
	const workflowState = projectWorkflowState(options.store.replay(sessionId));
	const sourceResults = buildPolicySourceResults(prepared);
	const policyEvaluation = POLICY_ENGINE.evaluate({
		event: agentEvent,
		workflowState,
		sourceResults,
	});
	const events: EventRecord[] = [
		options.store.append({
			sessionId,
			ts,
			type: "tool.execute.before",
			payload,
		}),
	];
	const policyDecisions = recordPolicyDecisions(options.store, {
		sessionId,
		ts,
		eventId: events[0]?.id ?? null,
		evaluation: policyEvaluation,
		events,
	});
	const blockingDecision = policyEvaluation.decisions.find(
		(decision) => decision.action === "deny" && decision.enforced,
	);

	if (blockingDecision) {
		const result: McpToolExecutionResult = {
			tool: prepared.name,
			sessionId,
			cwd,
			blocked: true,
			error: blockingDecision.reason,
			events,
			policyEvaluation,
			policyDecisions,
		};
		events.push(
			options.store.append({
				sessionId,
				ts,
				type: "mcp.tool.blocked",
				payload: {
					tool: prepared.name,
					reason: blockingDecision.reason,
					ruleId: blockingDecision.ruleId,
				},
			}),
		);
		return result;
	}

	try {
		const output = prepared.run();
		events.push(
			options.store.append({
				sessionId,
				ts,
				type: "tool.execute.after",
				payload: {
					...payload,
					toolResponse: output,
				},
			}),
		);
		return {
			tool: prepared.name,
			sessionId,
			cwd,
			blocked: false,
			output,
			events,
			policyEvaluation,
			policyDecisions,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		events.push(
			options.store.append({
				sessionId,
				ts,
				type: "tool.execute.after",
				payload: {
					...payload,
					error: message,
				},
			}),
		);
		return {
			tool: prepared.name,
			sessionId,
			cwd,
			blocked: false,
			error: message,
			events,
			policyEvaluation,
			policyDecisions,
		};
	}
}

function prepareMcpTool(
	name: PavedaMcpToolName,
	args: unknown,
	cwd: string,
	store: EventStore,
): PreparedMcpTool {
	const input = isRecord(args) ? args : {};

	switch (name) {
		case "paveda.search":
			return prepareSearch(input, cwd);
		case "paveda.search_semantic":
			return prepareSemanticSearch(input, store);
		case "paveda.read":
			return prepareRead(input, cwd);
		case "paveda.patch":
			return preparePatch(input, cwd);
		case "paveda.shell":
			return prepareShell(input, cwd);
		case "paveda.git":
			return prepareGit(input, cwd);
		case "paveda.test":
			return prepareTest(input, cwd);
	}
}

function prepareSearch(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const query = requireString(input, "query");
	const glob = readString(input, "glob");
	const limit = readPositiveInteger(input, "limit") ?? 50;
	const rgArgs = ["--line-number", "--column", "--max-count", String(limit), query];
	if (glob) {
		rgArgs.unshift("--glob", glob);
	}

	return {
		name: "paveda.search",
		toolName: "mcp",
		toolInput: { query, glob, limit },
		run: () => ({
			matches: runCommand("rg", rgArgs, cwd),
		}),
	};
}

function prepareSemanticSearch(input: Record<string, unknown>, store: EventStore): PreparedMcpTool {
	const query = requireString(input, "query");
	const topK = readPositiveInteger(input, "top_k") ?? 5;
	const since = readString(input, "since");
	return {
		name: "paveda.search_semantic",
		toolName: "mcp",
		toolInput: { query, top_k: topK, since },
		run: () => ({
			results: semanticSearchLedger(store, {
				query,
				limit: topK,
				since: since ? Date.parse(since) : undefined,
			}),
		}),
	};
}

function prepareRead(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const path = resolveProjectPath(cwd, requireString(input, "path"));
	const maxChars = readPositiveInteger(input, "maxChars") ?? 20000;

	return {
		name: "paveda.read",
		toolName: "mcp",
		toolInput: { path, maxChars },
		run: () => {
			assertPathDoesNotUseSymlinks(path, "MCP read path");
			const content = readFileSync(path, "utf8");
			return {
				path,
				content: content.length > maxChars ? content.slice(0, maxChars) : content,
				truncated: content.length > maxChars,
			};
		},
	};
}

function preparePatch(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const path = resolveProjectPath(cwd, requireString(input, "path"));
	const content = requireString(input, "content");

	return {
		name: "paveda.patch",
		toolName: "Write",
		toolInput: { file_path: path, content },
		run: () => {
			assertWritePathIsSafe(path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
			return {
				path,
				bytes: Buffer.byteLength(content),
				written: true,
			};
		},
	};
}

function prepareShell(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const command = requireString(input, "command");

	return {
		name: "paveda.shell",
		toolName: "Bash",
		toolInput: { command },
		run: () => ({
			stdout: execSync(command, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		}),
	};
}

function prepareGit(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const args = readStringArray(input, "args");
	if (args.length === 0) {
		throw new Error("paveda.git requires args");
	}
	const command = `git ${args.join(" ")}`;

	return {
		name: "paveda.git",
		toolName: "Bash",
		toolInput: { command },
		run: () => ({
			stdout: execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		}),
	};
}

function prepareTest(input: Record<string, unknown>, cwd: string): PreparedMcpTool {
	const command = readString(input, "command") ?? "pnpm test";

	return {
		name: "paveda.test",
		toolName: "Bash",
		toolInput: { command },
		run: () => ({
			stdout: execSync(command, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		}),
	};
}

function buildPolicySourceResults(prepared: PreparedMcpTool): PolicySourceResults {
	const toolPayload = {
		toolName: prepared.toolName,
		toolInput: prepared.toolInput,
	};

	return {
		toolPayload,
		destructiveGuard: evaluateDestructiveGuard(toolPayload),
		toolingEnforce: evaluateToolingEnforce(toolPayload),
		blastCheck: evaluateBlastCheck(toolPayload),
	};
}

function recordPolicyDecisions(
	store: EventStore,
	input: {
		sessionId: string;
		ts: number;
		eventId: number | null;
		evaluation: PolicyEvaluation;
		events: EventRecord[];
	},
): PolicyDecisionRecord[] {
	const records: PolicyDecisionRecord[] = [];

	for (const decision of input.evaluation.decisions) {
		const record = store.appendPolicyDecision({
			sessionId: input.sessionId,
			ts: input.ts,
			eventId: input.eventId,
			host: input.evaluation.event.host,
			ruleId: decision.ruleId,
			action: decision.action,
			severity: decision.severity,
			tier: decision.tier,
			reason: decision.reason,
			enforced: decision.enforced,
			evidence: decision.evidence,
		});
		records.push(record);
		input.events.push(
			store.append({
				sessionId: input.sessionId,
				ts: input.ts,
				type: "policy.decision",
				payload: record,
			}),
		);
	}

	return records;
}

function runCommand(command: string, args: string[], cwd: string): string {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		if (isNodeError(error) && error.status === 1) {
			return "";
		}
		throw error;
	}
}

function parseMcpToolName(value: string): PavedaMcpToolName {
	if (
		value === "paveda.search" ||
		value === "paveda.search_semantic" ||
		value === "paveda.read" ||
		value === "paveda.patch" ||
		value === "paveda.shell" ||
		value === "paveda.git" ||
		value === "paveda.test"
	) {
		return value;
	}

	throw new Error(`Unsupported Paveda MCP tool: ${value}`);
}

function resolveProjectPath(cwd: string, path: string): string {
	const resolved = resolve(cwd, path);
	if (resolved !== cwd && !resolved.startsWith(`${cwd}/`)) {
		throw new Error(`MCP path escapes cwd: ${path}`);
	}
	return resolved;
}

function requireString(input: Record<string, unknown>, key: string): string {
	const value = readString(input, key);
	if (!value) {
		throw new Error(`Missing required MCP argument: ${key}`);
	}
	return value;
}

function readString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function readPositiveInteger(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`MCP argument ${key} must be a positive integer`);
	}
	return value;
}

function readStringArray(input: Record<string, unknown>, key: string): string[] {
	const value = input[key];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`MCP argument ${key} must be a string array`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException & { status?: number } {
	return error instanceof Error;
}
