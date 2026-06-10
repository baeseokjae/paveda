# Paveda Verification Reference

Verification proves that a run satisfies the active Paveda profile.
Use this reference when `/do` reaches test, review, repair, and handoff phases.

## Ladder

Evaluate evidence in this order when the profile lists the evidence kind:

1. `command`
2. `unit_test`
3. `e2e_test`
4. `semantic_review`
5. `adversarial_review`
6. `risk_review`
7. `security_scan`
8. `manual_decision`
9. `host_event`
10. `typecheck`
11. `lint`
12. `build`
13. `coverage`

The profile decides which ladder items are required for the current task type.

## Gate Results

| Result | Meaning |
| --- | --- |
| `pass` | Direct evidence satisfies the required gate. |
| `not_applicable` | The task is `docs` or `metadata`, the gate allows it, and evidence includes rationale, classifier reason, and approval metadata. |
| `block` | Evidence is missing, failed, inconclusive, invalid, or uses `not_applicable` for a code-changing task. |
| `not_required` | The evidence kind is visible in the ladder but no required gate applies to this task type. |

## Code-Changing Tasks

Task types `code`, `ui`, `api`, `data`, `infra`, `test`, and `mixed` change executable behavior or system boundaries.

For these tasks:

- `unit_test` must pass when the profile requires `unit-gate`.
- `e2e_test` or package-level e2e must pass when the profile requires `e2e-gate`.
- `not_applicable` does not satisfy unit/e2e gates.
- Missing test infrastructure blocks and should trigger a separate setup sprint decision.

## Docs And Metadata Tasks

Task types `docs` and `metadata` can satisfy test gates with audited `not_applicable` evidence:

```json
{
  "result": "not_applicable",
  "rationale": "Docs-only change does not alter executable behavior.",
  "metadata": {
    "classifierReason": "Changed files are documentation only.",
    "userApproval": true
  }
}
```

## Score

`verification_score` is:

```text
(passed gates + valid not_applicable gates) / required gates
```

Strict profile requires `1`.
Any blocked gate makes the run fail, even if the numeric score meets a lower profile threshold.
