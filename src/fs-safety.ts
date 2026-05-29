import { lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function writeTextFileSafely(path: string, content: string): void {
	assertWritePathIsSafe(path);
	writeFileSync(path, content);
}

export function assertWritePathIsSafe(path: string): void {
	assertPathDoesNotUseSymlinks(path, "Output path");
}

export function assertPathDoesNotUseSymlinks(path: string, label: string): void {
	for (const candidate of pathAncestry(path)) {
		try {
			if (lstatSync(candidate).isSymbolicLink() && !isRootLevelPath(candidate)) {
				throw new Error(`${label} must not use symlinks: ${candidate}`);
			}
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				continue;
			}

			throw error;
		}
	}
}

function pathAncestry(path: string): string[] {
	const resolved = resolve(path);
	const candidates: string[] = [];
	let current = resolved;

	while (true) {
		candidates.push(current);
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}

	return candidates.reverse();
}

function isRootLevelPath(path: string): boolean {
	const parent = dirname(path);
	return parent === dirname(parent);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
