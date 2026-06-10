---
name: do
description: "Paveda universal contract shell for implementation tasks. Uses the host's native goal, workflow, loop, planner, and tool primitives first, while enforcing ledger, evidence, score, unit, and e2e gates."
argument-hint: "[--from-spec <path>] [--profile fast|standard|strict|release] [--task-type code|ui|api|data|infra|test|docs|metadata|mixed] <task description>"
allowed-tools: Bash, Bash(node:*), Bash(git:*), Read, Write, Edit, Glob, Grep, AskUserQuestion, Skill, Agent
router: enabled
ambiguity-required: 0.15
---

# /do - Paveda Contract Shell

Use `/do` to start implementation work under the Paveda universal contract.
Paveda supplies the shared contract, ledger, projection, scoring, and evidence rules.
The host supplies the native execution primitive: Claude Code workflows and loops, Codex goals, or the closest native plan/run loop in pi or Hermes.

Do not reimplement or override the host's native workflow. Wrap it with the contract below.

## Required Start

1. Resolve `PROJECT_ROOT` from `git rev-parse --show-toplevel` or the current directory.
2. Confirm the `.paveda` manifest, contract, active profile, and active host declaration exist.
3. Run projection status for the active host:

```bash
paveda projection status --host <host> --cwd "$PROJECT_ROOT"
```

If projection drift exists, block before changing files. Ask the user to choose one explicit recovery path:

- `paveda projection diff --host <host> --cwd "$PROJECT_ROOT"`
- `paveda projection regenerate --host <host> --cwd "$PROJECT_ROOT" --write`
- `paveda projection import --host <host> --cwd "$PROJECT_ROOT" --path <path> --reason <reason> --write`
- `paveda projection approve-override --host <host> --cwd "$PROJECT_ROOT" --path <path> --reason <reason> --expires-at <ISO> --write`

Never silently overwrite drifted generated files.

## Run Creation

Start every task with a ledger run:

```bash
paveda do --host <host> --profile strict --task-type <task-type> --cwd "$PROJECT_ROOT" "<objective>"
```

Rules:

- Default profile is `strict`.
- `release` profile is declared but not executable in MVP. If requested, stop with `not_supported_in_mvp`; do not downgrade to `strict`.
- `run_id` is UUID v7 and becomes the evidence key for the whole task.
- Acceptance criteria should be copied into the run when known.
- Manifest configuration wins over repo auto-detection. If auto-detection is used, record confidence in the ledger or evidence rationale.

## Host-Native Execution

Use the host's native primitive for the work loop:

- Codex: use goals, plans, shell commands, and continuation semantics.
- Claude Code: use native workflows, loops, agents, and tool calling.
- pi and Hermes: use their closest native workflow/plan/run primitive.

Paveda only requires phase mapping:

| Paveda phase | Host action |
| --- | --- |
| `intake` | Capture objective, task type, acceptance criteria |
| `clarify` | Use native clarification workflow when ambiguity is high |
| `plan` | Use native planning primitive and record plan-quality evidence when required |
| `execute` | Make scoped changes through host-native tools |
| `unit-test` | Run required unit gate |
| `e2e-test` | Run required e2e or package-level gate |
| `semantic-adversarial-verification` | Review completeness, consistency, risk, and user-visible behavior |
| `repair` | Use native loop to fix failed gates |
| `handoff` | Summarize changes, evidence, and remaining risks |

## Test Gate Rules

Code-changing task types are `code`, `ui`, `api`, `data`, `infra`, `test`, and `mixed`.
For these task types:

- Unit evidence is mandatory when required by the active profile.
- E2E or package-level E2E evidence is mandatory when required by the active profile.
- `not_applicable`, missing evidence, inconclusive evidence, and failed evidence block the task.
- If minimum test infrastructure does not exist, ask whether to add it in a separate setup sprint before implementation continues.

Docs-only and metadata/config-only work must use task type `docs` or `metadata`.
For these task types, test gates may pass only with auditable `not_applicable` evidence:

- `result`: `not_applicable`
- `rationale`: why executable behavior did not change
- `metadata.classifierReason`: why the task was classified as docs/metadata
- `metadata.userApproval`: `true` or `metadata.approvedBy`: non-empty actor

Do not record `skip`. Paveda evidence results are `pass`, `fail`, `block`, `not_applicable`, and `inconclusive`.

## Evidence Recording

Record evidence with the run id:

```bash
paveda evidence add --run <run_id> --phase unit-test --id unit-pass --kind unit_test --result pass --command "<unit test command>" --exit-code 0 --rationale "Focused unit tests passed"
paveda evidence add --run <run_id> --phase e2e-test --id e2e-pass --kind e2e_test --result pass --command "<package e2e command>" --exit-code 0 --rationale "Package-level e2e passed"
```

Use `paveda run <host> -- <native command>` when the command should be wrapped directly by Paveda. Use plain host-native commands when the host already captures the execution, then add evidence explicitly.

## Verification

Before handoff, run:

```bash
paveda verify --run <run_id> --profile <profile> --cwd "$PROJECT_ROOT" --write
```

The task can finish only when `/verify` returns `ok: true`.
If `/verify` blocks, repair the concrete gate and rerun verification.
In strict profile, `verification_score` must meet the profile threshold and all required gates must be `pass` or valid `not_applicable`.

## Handoff

Final handoff must include:

- `run_id`
- Changed files
- Unit and e2e/package-level evidence
- Semantic/risk review evidence
- Verification score and blocked gate count
- Any audited override or drift resolution
- Remaining risks or deferred work
