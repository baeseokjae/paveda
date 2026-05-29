---
name: dead-code
description: "Investigate unused files, exports, dependencies, and unreachable code with language-appropriate tools. Use when cleaning up code or auditing dependency usage."
argument-hint: "[--fix]"
allowed-tools: Bash, Glob, Grep, Read, Edit
---

# /dead-code - Unused Code Investigation

Use this skill to find and remove unused code only when the removal is requested or clearly inside the approved task scope.

## Workflow

1. Detect the project language and package manager from current files.
2. Prefer existing scripts such as `lint`, `test`, or project-specific unused-code checks.
3. If no script exists, choose a language-appropriate read-only detector when available:
   - TypeScript/JavaScript: dependency/export analyzers, compiler checks, and test coverage clues
   - Python: import and unreachable-code analyzers
   - Go: compiler, vet/static analysis, and package graph checks
4. Confirm each candidate has no reachable import, runtime reference, config reference, or documented extension role.
5. Remove only approved candidates.
6. Run focused verification after removals.

## Safety Rules

- Do not delete files because they look unused from a single search.
- Treat generated code, migrations, public API files, plugin entrypoints, and configuration-discovered modules as high risk.
- Keep dependency removals tied to lockfile and manifest updates.
- Report ambiguous candidates instead of deleting them.

## Output

Return:

- detector commands used
- removed files or dependencies
- candidates left untouched and why
- verification commands and results
