export interface BlastCheckResult {
	warnings: string[];
	additionalContext: string | null;
}

export interface EvaluateBlastCheckInput {
	toolName?: string;
	toolInput?: unknown;
}

const DEPENDENCY_MANIFEST_WARNING =
	"Dependency manifest change detected. Sync the project lockfile or dependency metadata.";

export function evaluateBlastCheck(input: EvaluateBlastCheckInput): BlastCheckResult {
	if (input.toolName !== "Edit" && input.toolName !== "Write" && input.toolName !== "apply_patch") {
		return noWarnings();
	}

	const changes = extractFileChanges(input.toolName, input.toolInput);
	if (changes.length === 0) {
		return noWarnings();
	}

	const warnings: string[] = [];

	for (const change of changes) {
		if (looksLikeDependencyManifestChange(change.basename, change.content)) {
			warnings.push(DEPENDENCY_MANIFEST_WARNING);
		}

		if (/(schema\.ts|\.prisma)$/.test(change.basename)) {
			warnings.push("Database schema change detected. Check whether a migration is required.");
		}
	}

	const uniqueWarnings = [...new Set(warnings)];
	return {
		warnings: uniqueWarnings,
		additionalContext: uniqueWarnings.length > 0 ? uniqueWarnings.join("\n") : null,
	};
}

function noWarnings(): BlastCheckResult {
	return { warnings: [], additionalContext: null };
}

function looksLikeDependencyManifestChange(basename: string, content: string): boolean {
	if (basename === "package.json") {
		return looksLikePackageJsonDependencyChange(content);
	}

	if (basename === "pyproject.toml") {
		return looksLikePyprojectDependencyChange(content);
	}

	return false;
}

function looksLikePackageJsonDependencyChange(content: string): boolean {
	return (
		/"(dependencies|devDependencies|peerDependencies|optionalDependencies)"/.test(content) ||
		/"[^"]+"\s*:\s*"[\^~>=<0-9]/.test(content)
	);
}

function looksLikePyprojectDependencyChange(content: string): boolean {
	return (
		/^\s*(dependencies|optional-dependencies)\s*=/m.test(content) ||
		/^\s*\[(?:tool\.poetry(?:\.group\.[A-Za-z0-9_-]+)?\.dependencies|dependency-groups)\]\s*$/m.test(
			content,
		)
	);
}

function readStringProperty(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
		return undefined;
	}

	const property = value[key as keyof typeof value];
	return typeof property === "string" ? property : undefined;
}

function extractFileChanges(
	toolName: string,
	toolInput: unknown,
): Array<{ basename: string; content: string }> {
	if (toolName === "apply_patch") {
		const patch = readStringProperty(toolInput, "patch");
		if (!patch) {
			return [];
		}

		return extractPatchFilePaths(patch).map((path) => ({
			basename: path.split("/").at(-1) ?? path,
			content: patch,
		}));
	}

	const filePath = readStringProperty(toolInput, "file_path");
	if (!filePath) {
		return [];
	}

	return [
		{
			basename: filePath.split("/").at(-1) ?? filePath,
			content:
				readStringProperty(toolInput, "new_string") ??
				readStringProperty(toolInput, "content") ??
				"",
		},
	];
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
