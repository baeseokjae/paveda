---
name: docs-writer
description: "Create and maintain project documentation with explicit evidence, stable file naming, and drift checks. Use for specs, plans, reports, reviews, runbooks, and architecture notes."
argument-hint: "[plan|spec|report|review|runbook] <topic>"
allowed-tools: Bash, Glob, Grep, Read, Write, Edit
---

# /docs-writer - Documentation Workflow

Use this skill when documentation is itself the deliverable, or when a change creates durable knowledge that future agents should not rediscover.

## Scope

Write project-owned documentation only. Do not encode product-specific paths, service names, infrastructure IDs, credentials, or private endpoints in this skill. Load those details from the current repository.

## Document Types

| Type | Default location | Purpose |
|---|---|---|
| `spec` | `docs/specs/` | Requirements, user outcomes, constraints, and acceptance criteria |
| `plan` | `docs/plans/` | Implementation plan that can be handed to an execution workflow |
| `report` | `docs/reports/` | Investigation result, tradeoff analysis, or operational finding |
| `review` | `docs/reviews/` | Review findings with severity, evidence, and recommended action |
| `runbook` | `docs/runbooks/` | Repeatable operational procedure |

If the repository already uses a different documentation layout, follow the repository layout and state which convention was detected.

## Workflow

1. Identify the requested document type and topic.
2. Inspect the current repository files that make the document verifiable.
3. Reuse nearby document structure when it exists.
4. Name new files with `YYYY-MM-DD-topic.md` unless the repository already has a stronger convention.
5. Include a short evidence section with file paths, commands, or runtime observations.
6. Separate facts from assumptions. Mark assumptions explicitly.
7. Keep operational steps reproducible and avoid local-machine-only state unless the document is a local runbook.

## Drift Check

Before finishing, check whether the new or changed document conflicts with:

- `README.md`
- `AGENTS.md` or host instruction files
- `docs/architecture.md`
- current package scripts, workflow files, or config files touched by the request

Report unresolved drift instead of silently choosing one document over another.

## Output

Return:

- files created or changed
- evidence used
- assumptions left in the document
- follow-up verification that would make the document stronger
