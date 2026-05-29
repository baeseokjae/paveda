---
name: review
description: "Run a repository health or release-readiness review across code, tests, docs, configuration, dependencies, and operational surfaces. Use before release, after large changes, or for explicit review requests."
argument-hint: "[--scope working-tree|branch|release] [--deep]"
allowed-tools: Bash, Glob, Grep, Read
---

# /review - Repository Review

Use this skill for read-only review. Prioritize real defects, regressions, missing tests, and operational risk.

## Review Contract

Findings come first. Order them by severity. Each finding needs:

- severity: `critical`, `high`, `medium`, or `low`
- exact file path or command evidence
- impact
- recommended fix

If no issues are found, say that directly and list remaining test or evidence gaps.

## Scope Selection

- `working-tree`: review current uncommitted changes and directly related files.
- `branch`: compare branch changes against the default branch when available.
- `release`: include package metadata, build scripts, docs, runtime smoke paths, and published files.
- `--deep`: broaden to dependency, config, docs drift, security-sensitive edits, and operational scripts.

Default to `working-tree` when no scope is provided.

## Checklist

1. Inspect git status and changed files.
2. Read the changed files and nearby tests.
3. Check behavior contracts exposed through docs, manifests, or public APIs.
4. Look for missing tests proportional to risk.
5. Check dependency and lockfile consistency when manifests changed.
6. Check docs drift when behavior, scripts, setup, or architecture changed.
7. Check generated or packaged outputs only when release scope requires them.

## Output

Use this structure:

1. Findings
2. Open questions or assumptions
3. Test gaps
4. Brief change summary only when useful

Do not rewrite code while reviewing unless the user asks for fixes.
