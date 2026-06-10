---
name: verify
description: "Evaluate a Paveda run against the active profile's verification ladder, required gates, evidence, score thresholds, and not_applicable policy."
argument-hint: "--run <uuid-v7> [--profile fast|standard|strict|release] [--write]"
allowed-tools: Bash, Glob, Grep, Read
---

# /verify - Paveda Verification Ladder

Use `/verify` to decide whether a Paveda run can finish.
The authoritative machine inputs are the `.paveda` contract source and the active profile manifest.
Host-native commands may produce evidence, but Paveda decides pass/block from the profile manifest and ledger.

## Usage

```bash
paveda verify --run <run_id> --profile strict --cwd "$PROJECT_ROOT"
paveda verify --run <run_id> --profile strict --cwd "$PROJECT_ROOT" --write
```

`--write` records `verification_score` and blocking policy violations in the ledger.

## Execution Order

### 1. Load Contract State

1. Resolve project root.
2. Load the `.paveda` manifest, contract source, active profile manifest, and run ledger.
3. If the requested profile is `release`, stop with `not_supported_in_mvp`; do not downgrade.
4. Validate generated projections before trusting host-specific files.

### 2. Read Run Context

Read the run's objective, host, profile, task type, acceptance criteria, phase events, artifacts, scores, decisions, and evidence.
Task type controls which required gates apply.

Code-changing task types:

- `code`
- `ui`
- `api`
- `data`
- `infra`
- `test`
- `mixed`

Non-testable task types:

- `docs`
- `metadata`

### 3. Evaluate Required Gates

For each `requiredGates[]` entry whose `requiredForTaskTypes[]` contains the run task type:

1. Find ledger evidence by `evidenceKind`.
2. `pass` evidence satisfies the gate.
3. `fail`, `block`, or `inconclusive` evidence blocks the gate.
4. Missing evidence blocks the gate.
5. `not_applicable` evidence satisfies the gate only when all conditions are true:
   - the gate allows `not_applicable`
   - the profile allows `not_applicable` for the task type
   - the evidence includes rationale when required
   - the evidence includes `metadata.classifierReason` when required
   - the evidence includes `metadata.userApproval: true` or `metadata.approvedBy`

For code-changing tasks, unit and e2e gates must not use `not_applicable`.
Missing unit/e2e infrastructure blocks and should trigger a setup-sprint decision.

### 4. Build Verification Ladder

Report every evidence kind from `verificationLadder[]`.
Each ladder step is one of:

- `pass`: all required gates for that evidence kind passed
- `not_applicable`: required gates are explicitly and validly not applicable
- `block`: one or more required gates failed, are inconclusive, are missing, or have invalid not-applicable evidence
- `not_required`: evidence kind is listed or recorded but has no required gate for this task type

The default strict ladder is:

1. command
2. unit_test
3. e2e_test
4. semantic_review
5. adversarial_review
6. risk_review
7. security_scan
8. manual_decision
9. host_event
10. typecheck
11. lint
12. build
13. coverage

### 5. Score

Compute `verification_score` from required gates:

```text
(passed gates + valid not_applicable gates) / required gates
```

The run passes only when:

- every required gate is `pass` or valid `not_applicable`
- `verification_score >= profile.scoreThresholds[verification_score].pass`

Strict profile requires a perfect score of `1`.

### 6. Output

Return:

- `ok`
- `gates[]`
- `ladder[]`
- `scoreSummary`
- `score` when `--write` is used
- `policyViolations[]` when `--write` is used and gates block

If `ok` is false, do not hand off as complete. Repair the blocked gate or run an approved setup sprint first.
