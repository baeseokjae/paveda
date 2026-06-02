import { stdin, stdout } from "node:process";
import { EventStore, resolveStorePath } from "../store/index.js";
import type { StoreScope } from "../store/index.js";
import { executeMcpTool } from "./executor.js";

export interface McpServerOptions {
	cwd?: string;
	dbPath?: string;
	storeScope?: StoreScope;
	sessionId?: string;
	policyCachePath?: string;
}

export interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

const MCP_PROTOCOL_VERSION = "2025-11-25";

export const PAVEDA_MCP_TOOLS = [
	{
		name: "paveda.search",
		description: "Search project files with rg through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				glob: { type: "string" },
				limit: { type: "integer", minimum: 1 },
			},
			required: ["query"],
		},
	},
	{
		name: "paveda.read",
		description: "Read a project file through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				maxChars: { type: "integer", minimum: 1 },
			},
			required: ["path"],
		},
	},
	{
		name: "paveda.patch",
		description: "Write file content through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string" },
				content: { type: "string" },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "paveda.shell",
		description: "Run a shell command through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: ["command"],
		},
	},
	{
		name: "paveda.git",
		description: "Run git with argv through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				args: {
					type: "array",
					items: { type: "string" },
				},
			},
			required: ["args"],
		},
	},
	{
		name: "paveda.test",
		description: "Run a verification command through Paveda policy mediation.",
		inputSchema: {
			type: "object",
			properties: {
				command: { type: "string" },
			},
		},
	},
] as const;

export async function serveMcpStdio(options: McpServerOptions = {}): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const dbPath = options.dbPath ?? resolveStorePath(options.storeScope ?? "project", cwd);
	const store = new EventStore(dbPath);

	try {
		for await (const request of readJsonRpcRequests()) {
			const response = handleMcpRequest(request, { ...options, cwd, store });
			if (response) {
				stdout.write(`${JSON.stringify(response)}\n`);
			}
		}
	} finally {
		store.close();
	}
}

export function handleMcpRequest(
	request: JsonRpcRequest,
	context: McpServerOptions & { store: EventStore },
): JsonRpcResponse | null {
	const id = request.id ?? null;

	try {
		switch (request.method) {
			case "initialize":
				return ok(id, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {
						tools: {},
					},
					serverInfo: {
						name: "paveda",
						version: "0.1.0",
					},
				});
			case "notifications/initialized":
				return null;
			case "ping":
				return ok(id, {});
			case "tools/list":
				return ok(id, { tools: PAVEDA_MCP_TOOLS });
			case "tools/call":
				return ok(id, formatToolCallResult(executeMcpTool(readToolCall(request.params, context))));
			default:
				return fail(id, -32601, `Unsupported MCP method: ${request.method ?? ""}`);
		}
	} catch (error) {
		return fail(id, -32000, error instanceof Error ? error.message : String(error));
	}
}

function readToolCall(
	params: unknown,
	context: McpServerOptions & { store: EventStore },
): Parameters<typeof executeMcpTool>[0] {
	if (!isRecord(params) || typeof params.name !== "string") {
		throw new Error("tools/call requires a tool name");
	}

	return {
		name: params.name,
		arguments: params.arguments,
		cwd: context.cwd,
		sessionId: context.sessionId,
		policyCachePath: context.policyCachePath,
		store: context.store,
	};
}

function formatToolCallResult(result: ReturnType<typeof executeMcpTool>): unknown {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify(result, null, 2),
			},
		],
		isError: result.blocked || Boolean(result.error),
	};
}

async function* readJsonRpcRequests(): AsyncGenerator<JsonRpcRequest> {
	let buffer = "";

	for await (const chunk of stdin) {
		buffer += String(chunk);
		while (true) {
			const framed = takeContentLengthMessage(buffer);
			if (framed) {
				buffer = framed.remaining;
				yield parseJsonRpcRequest(framed.body);
				continue;
			}

			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				break;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line) {
				yield parseJsonRpcRequest(line);
			}
		}
	}

	const trailing = buffer.trim();
	if (trailing) {
		yield parseJsonRpcRequest(trailing);
	}
}

function takeContentLengthMessage(buffer: string): { body: string; remaining: string } | undefined {
	if (!buffer.startsWith("Content-Length:")) {
		return undefined;
	}

	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd === -1) {
		return undefined;
	}

	const header = buffer.slice(0, headerEnd);
	const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
	if (!lengthMatch?.[1]) {
		throw new Error("Invalid Content-Length MCP frame");
	}

	const length = Number(lengthMatch[1]);
	const bodyStart = headerEnd + 4;
	const bodyEnd = bodyStart + length;
	if (buffer.length < bodyEnd) {
		return undefined;
	}

	return {
		body: buffer.slice(bodyStart, bodyEnd),
		remaining: buffer.slice(bodyEnd),
	};
}

function parseJsonRpcRequest(raw: string): JsonRpcRequest {
	const parsed = JSON.parse(raw) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("JSON-RPC request must be an object");
	}
	return parsed;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		result,
	};
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
