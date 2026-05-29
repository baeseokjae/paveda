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
	if (input.toolName !== "Edit" && input.toolName !== "Write") {
		return noWarnings();
	}

	const filePath = readStringProperty(input.toolInput, "file_path");
	if (!filePath) {
		return noWarnings();
	}

	const basename = filePath.split("/").at(-1) ?? filePath;
	const content =
		readStringProperty(input.toolInput, "new_string") ??
		readStringProperty(input.toolInput, "content") ??
		"";
	const warnings: string[] = [];

	if (looksLikeDependencyManifestChange(basename, content)) {
		warnings.push(DEPENDENCY_MANIFEST_WARNING);
	}

	if (/(schema\.ts|\.prisma)$/.test(basename)) {
		warnings.push("Database schema change detected. Check whether a migration is required.");
	}

	return {
		warnings,
		additionalContext: warnings.length > 0 ? warnings.join("\n") : null,
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
