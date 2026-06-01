import type { HostCapability } from "./types.js";

const DEFAULT_CAPABILITY: HostCapability = {
	host: "unknown",
	canBlockBeforeTool: false,
	canGatePermissionRequest: false,
	canRewriteToolInput: false,
	canStopAfterTool: false,
	supportsManagedConfig: false,
	supportsMcpGateway: false,
	nativeToolBypassRisk: "high",
	coveredToolMatchers: [],
};

const HOST_CAPABILITIES: Record<string, HostCapability> = {
	"claude-code": {
		host: "claude-code",
		canBlockBeforeTool: true,
		canGatePermissionRequest: true,
		canRewriteToolInput: true,
		canStopAfterTool: false,
		supportsManagedConfig: false,
		supportsMcpGateway: true,
		nativeToolBypassRisk: "low",
		coveredToolMatchers: ["Bash", "Edit", "Write", "apply_patch", "Agent"],
	},
	codex: {
		host: "codex",
		canBlockBeforeTool: true,
		canGatePermissionRequest: true,
		canRewriteToolInput: false,
		canStopAfterTool: false,
		supportsManagedConfig: true,
		supportsMcpGateway: true,
		nativeToolBypassRisk: "medium",
		coveredToolMatchers: ["Bash", "apply_patch", "mcp"],
	},
	mcp: {
		host: "mcp",
		canBlockBeforeTool: true,
		canGatePermissionRequest: false,
		canRewriteToolInput: true,
		canStopAfterTool: true,
		supportsManagedConfig: false,
		supportsMcpGateway: true,
		nativeToolBypassRisk: "medium",
		coveredToolMatchers: ["Bash", "Edit", "Write", "apply_patch", "Git", "mcp"],
	},
	hermes: {
		host: "hermes",
		canBlockBeforeTool: true,
		canGatePermissionRequest: false,
		canRewriteToolInput: false,
		canStopAfterTool: false,
		supportsManagedConfig: false,
		supportsMcpGateway: true,
		nativeToolBypassRisk: "medium",
		coveredToolMatchers: ["Bash", "Edit", "Write", "apply_patch", "Agent", "mcp"],
	},
	pi: {
		host: "pi",
		canBlockBeforeTool: true,
		canGatePermissionRequest: true,
		canRewriteToolInput: true,
		canStopAfterTool: false,
		supportsManagedConfig: false,
		supportsMcpGateway: true,
		nativeToolBypassRisk: "medium",
		coveredToolMatchers: ["Bash", "Edit", "Write", "apply_patch", "Agent", "mcp"],
	},
};

export const KNOWN_POLICY_HOSTS = Object.freeze(Object.keys(HOST_CAPABILITIES).sort());

export function resolveHostCapability(host: string | undefined): HostCapability {
	const normalizedHost = host ?? "unknown";
	const capability = HOST_CAPABILITIES[normalizedHost] ?? {
		...DEFAULT_CAPABILITY,
		host: normalizedHost,
	};
	return cloneHostCapability(capability);
}

export function listHostCapabilities(): HostCapability[] {
	return KNOWN_POLICY_HOSTS.map((host) => {
		const capability = HOST_CAPABILITIES[host];
		if (!capability) {
			throw new Error(`Unknown policy host: ${host}`);
		}
		return cloneHostCapability(capability);
	});
}

function cloneHostCapability(value: HostCapability): HostCapability {
	return {
		...value,
		coveredToolMatchers: [...value.coveredToolMatchers],
	};
}
