export type DestructiveGuardDecision = "allow" | "warn" | "deny";

export interface DestructiveGuardResult {
	decision: DestructiveGuardDecision;
	ruleId?: string;
	reason?: string;
	additionalContext: string | null;
}

export interface EvaluateDestructiveGuardInput {
	toolName?: string;
	toolInput?: unknown;
}

export function evaluateDestructiveGuard(
	input: EvaluateDestructiveGuardInput,
): DestructiveGuardResult {
	if (input.toolName === "Bash") {
		return evaluateBash(input.toolInput);
	}

	if (input.toolName === "Edit" || input.toolName === "Write") {
		return evaluateFileMutation(input.toolInput);
	}

	if (input.toolName === "apply_patch") {
		return evaluatePatch(input.toolInput);
	}

	return allow();
}

function evaluateBash(toolInput: unknown): DestructiveGuardResult {
	const command = readStringProperty(toolInput, "command");
	if (!command) {
		return allow();
	}

	if (writesEnvFile(command)) {
		return deny(
			"D-001",
			"D-001: Writing directly to .env files is blocked. Use a secure secret manager or environment-specific configuration.",
		);
	}

	if (writesSecretKeyFile(command)) {
		return deny(
			"D-005",
			"D-005: Creating secret key files (.pem/.key/.p12/.pfx/id_rsa/id_ed25519) is blocked. Use a secure secret store.",
		);
	}

	if (/\b(DROP\s+TABLE|TRUNCATE)\b/i.test(command)) {
		return deny(
			"D-002",
			"D-002: DROP TABLE / TRUNCATE commands are blocked because they can destroy data.",
		);
	}

	const rmCommands = parseRmCommands(command);
	for (const rmCommand of rmCommands) {
		if (isDangerousRm(rmCommand)) {
			return deny(
				"D-003",
				"D-003: Recursive force removal of root, home, current, or parent directory targets is blocked.",
			);
		}
	}

	for (const rmCommand of rmCommands) {
		if (
			rmCommand.targets.some((target) => target.includes("*")) &&
			rmCommand.targets.length >= 5 &&
			!/(tmp|temp|test|__test__|\.test\.|node_modules|dist|\.cache)/.test(command)
		) {
			return warn(
				"D-003",
				"D-003: rm with a wildcard appears to target five or more non-test paths. Confirm the scope before continuing.",
			);
		}
	}

	if (grantsWorldWritable(command)) {
		return warn(
			"D-006",
			"D-006: World-writable permissions were detected. Prefer the minimum required permission.",
		);
	}

	return allow();
}

function evaluateFileMutation(toolInput: unknown): DestructiveGuardResult {
	const filePath = readStringProperty(toolInput, "file_path");
	if (!filePath) {
		return allow();
	}

	return evaluateMutatedPath(filePath);
}

function evaluatePatch(toolInput: unknown): DestructiveGuardResult {
	const patch = readStringProperty(toolInput, "patch");
	if (!patch) {
		return allow();
	}

	for (const filePath of extractPatchFilePaths(patch)) {
		const result = evaluateMutatedPath(filePath);
		if (result.decision !== "allow") {
			return result;
		}
	}

	return allow();
}

function evaluateMutatedPath(filePath: string): DestructiveGuardResult {
	const basename = filePath.split("/").at(-1) ?? filePath;

	if (/^\.env(?:$|\.)/.test(basename) && !/\.example$/.test(basename)) {
		return deny(
			"D-004",
			"D-004: Editing .env files is blocked. Use environment-specific configuration outside source-controlled edits.",
		);
	}

	if (/\.(pem|key|p12|pfx)$/i.test(basename)) {
		return deny(
			"D-005",
			"D-005: Creating secret key files (.pem/.key/.p12/.pfx) is blocked. Use a secure secret store.",
		);
	}

	return allow();
}

function allow(): DestructiveGuardResult {
	return { decision: "allow", additionalContext: null };
}

function warn(ruleId: string, reason: string): DestructiveGuardResult {
	return { decision: "warn", ruleId, reason, additionalContext: reason };
}

function deny(ruleId: string, reason: string): DestructiveGuardResult {
	return { decision: "deny", ruleId, reason, additionalContext: null };
}

function readStringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
		return undefined;
	}

	const property = value[key as keyof typeof value];
	return typeof property === "string" ? property : undefined;
}

function writesEnvFile(command: string): boolean {
	return (
		/(?:^|\s)(?:\d?>|>>?)\s*["']?\.env(?!\.example)(?:$|[\s"']|\.[^\s"']*)/.test(command) ||
		/(?:^|\s)tee(?:\s+-a)?\s+["']?\.env(?!\.example)(?:$|[\s"']|\.[^\s"']*)/.test(command)
	);
}

function writesSecretKeyFile(command: string): boolean {
	return (
		/(?:^|\s)(?:\d?>|>>?)\s*["']?[^"'\s]*(?:\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519)(?:$|[\s"'])/i.test(
			command,
		) ||
		/(?:^|\s)tee(?:\s+-a)?\s+["']?[^"'\s]*(?:\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519)(?:$|[\s"'])/i.test(
			command,
		) ||
		/\b(?:openssl|ssh-keygen)\b.*\s(?:-out|-keyout|-f)\s+["']?[^"'\s]*(?:\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519)(?:$|[\s"'])/i.test(
			command,
		)
	);
}

function grantsWorldWritable(command: string): boolean {
	for (const segment of command.split(/&&|\|\||[;|]/)) {
		const parts = segment.trim().split(/\s+/).filter(Boolean).map(stripQuotes);
		const chmodIndex = parts.findIndex((part) => part === "chmod");
		if (chmodIndex === -1) {
			continue;
		}

		const mode = parts.slice(chmodIndex + 1).find((part) => !part.startsWith("-"));
		if (mode && isWorldWritableMode(mode)) {
			return true;
		}
	}

	return false;
}

function extractPatchFilePaths(patch: string): string[] {
	const paths = new Set<string>();

	for (const line of patch.split("\n")) {
		const codexMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
		if (codexMatch?.[1]) {
			paths.add(codexMatch[1].trim());
			continue;
		}

		const unifiedMatch = line.match(/^(?:---|\+\+\+) [ab]\/(.+)$/);
		if (unifiedMatch?.[1] && unifiedMatch[1] !== "/dev/null") {
			paths.add(unifiedMatch[1].trim());
		}
	}

	return [...paths];
}

function isWorldWritableMode(mode: string): boolean {
	if (/^[0-7]{3,4}$/.test(mode)) {
		return (Number.parseInt(mode.at(-1) ?? "0", 8) & 0o2) !== 0;
	}

	return mode
		.split(",")
		.some((clause) => /^([augo]*)([+=])([rwxXstugo]+)$/.test(clause) && addsOtherWrite(clause));
}

function addsOtherWrite(clause: string): boolean {
	const match = clause.match(/^([augo]*)([+=])([rwxXstugo]+)$/);
	if (!match) {
		return false;
	}

	const classes = match[1] ?? "";
	const operator = match[2];
	const permissions = match[3] ?? "";
	const affectsOther = classes === "" || classes.includes("a") || classes.includes("o");
	return affectsOther && (operator === "+" || operator === "=") && permissions.includes("w");
}

interface RmCommand {
	recursive: boolean;
	force: boolean;
	targets: string[];
}

function parseRmCommands(command: string): RmCommand[] {
	const result: RmCommand[] = [];

	for (const segment of command.split(/&&|\|\||[;|]/)) {
		const parts = segment.trim().split(/\s+/).filter(Boolean);
		const rmIndex = parts.findIndex((part) => stripQuotes(part) === "rm");
		if (rmIndex === -1) {
			continue;
		}

		let recursive = false;
		let force = false;
		const targets: string[] = [];

		for (const rawPart of parts.slice(rmIndex + 1)) {
			const part = stripQuotes(rawPart);
			if (part === "--") {
				continue;
			}
			if (part === "--recursive") {
				recursive = true;
				continue;
			}
			if (part === "--force") {
				force = true;
				continue;
			}
			if (part.startsWith("-") && part.length > 1) {
				recursive = recursive || /[rR]/.test(part);
				force = force || part.includes("f");
				continue;
			}
			targets.push(part);
		}

		result.push({ recursive, force, targets });
	}

	return result;
}

function isDangerousRm(command: RmCommand): boolean {
	if (!command.recursive || !command.force) {
		return false;
	}

	return command.targets.some(isDangerousRmTarget);
}

function isDangerousRmTarget(target: string): boolean {
	const normalized = target.replace(/\/+$/, "") || "/";
	return (
		normalized === "/" ||
		normalized === "/*" ||
		normalized === "." ||
		normalized === "./*" ||
		normalized === ".." ||
		normalized === "../*" ||
		normalized === "~" ||
		normalized === "~/*" ||
		normalized === "$HOME" ||
		normalized === "${HOME}" ||
		normalized === "$PWD" ||
		normalized === "${PWD}"
	);
}

function stripQuotes(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}
