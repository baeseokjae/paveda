export type ToolingEnforceDecision = "allow" | "deny";

export interface ToolingEnforceResult {
	decision: ToolingEnforceDecision;
	ruleId?: string;
	reason?: string;
	alternative?: string;
}

export interface EvaluateToolingEnforceInput {
	toolName?: string;
	toolInput?: unknown;
}

export function evaluateToolingEnforce(input: EvaluateToolingEnforceInput): ToolingEnforceResult {
	if (input.toolName !== "Bash") {
		return allow();
	}

	const command = readStringProperty(input.toolInput, "command");
	if (!command) {
		return allow();
	}

	for (const segment of splitCommandSegments(command)) {
		const result = evaluateCommandSegment(segment);
		if (result.decision === "deny") {
			return result;
		}
	}

	return allow();
}

function evaluateCommandSegment(segment: string): ToolingEnforceResult {
	const firstCommand = firstExecutableToken(segment);
	if (!firstCommand) {
		return allow();
	}

	switch (firstCommand) {
		case "cat":
			return deny("T-001", "Use the Read tool instead of cat for reading files.", "Read");
		case "head":
			return deny(
				"T-002",
				"Use the Read tool instead of head for reading files with offset/limit.",
				"Read",
			);
		case "tail":
			return deny(
				"T-003",
				"Use the Read tool instead of tail for reading files with offset/limit.",
				"Read",
			);
		case "bat":
		case "batcat":
			return deny("T-004", "Use the Read tool instead of bat for reading files.", "Read");
		case "grep":
			return deny("T-005", "Use the Grep tool instead of grep for content search.", "Grep");
		case "find":
			return deny("T-006", "Use the Glob tool instead of find for file search.", "Glob");
		case "sed":
			return deny("T-007", "Use the Edit tool instead of sed for file editing.", "Edit");
		case "awk":
			return deny(
				"T-008",
				"Use the Edit or Read tool instead of awk for file editing or processing.",
				"Edit/Read",
			);
		case "echo":
		case "printf":
			if (/>+\s*\S/.test(segment)) {
				return deny(
					"T-009",
					"Use the Write tool instead of echo/printf redirection for writing files.",
					"Write",
				);
			}
			return allow();
		default:
			return allow();
	}
}

function splitCommandSegments(command: string): string[] {
	return command.split(/&&|\|\||[;|]/).map((segment) => segment.trim());
}

function firstExecutableToken(segment: string): string | undefined {
	const parts = segment.split(/\s+/).filter(Boolean).map(stripQuotes);

	for (const part of parts) {
		if (isEnvAssignment(part)) {
			continue;
		}

		return part.split("/").at(-1);
	}

	return undefined;
}

function isEnvAssignment(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function allow(): ToolingEnforceResult {
	return { decision: "allow" };
}

function deny(ruleId: string, reason: string, alternative: string): ToolingEnforceResult {
	return { decision: "deny", ruleId, reason, alternative };
}

function readStringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
		return undefined;
	}

	const property = value[key as keyof typeof value];
	return typeof property === "string" ? property : undefined;
}
