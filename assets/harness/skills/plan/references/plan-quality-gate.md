# Plan Quality Gate

`/plan` saves implementation plans only after this gate passes. The gate prevents vague plans from entering `docs/plans/` and later causing ambiguous `/do --from-spec` execution.

## Verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| PASS | The plan is implementation-ready. | Continue to save. |
| WARN | The plan is usable but carries explicit risk. | Show warning in approval gate; user may continue. |
| FAIL | The plan is too vague or structurally unsafe. | Do not save; rerun Planner or request user correction. |

## Blocking Checks

Any blocking check failure returns `FAIL`.

1. **No placeholders**
   - Fail if the plan contains unresolved placeholders or filler such as `TBD`, `TODO`, `{...}`, `<...>`, `적절히`, `필요시`, `나중에`, `etc`, `테스트 추가`, or equivalent vague prose.
   - Exception: literal code examples may contain braces if they are clearly real syntax, not placeholders.
2. **Exact file paths**
   - Every task that creates, edits, deletes, or tests code must name concrete repo-relative file paths.
   - Directory-only targets are allowed only for discovery tasks, not implementation tasks.
3. **Verification commands**
   - Every sprint must include at least one concrete verification command.
   - Commands must be executable from the project root unless a package-relative working directory is explicitly stated.
4. **Expected results**
   - Every verification command must state the expected passing result.
   - "Should pass" is insufficient unless the exact command and relevant expected output or test scope are named.
5. **Observable acceptance criteria**
   - Acceptance criteria must be externally observable through UI behavior, API response, DB state, logs, or tests.
   - Internal implementation intent alone is not an acceptance criterion.
6. **Scope decomposition**
   - If a plan touches multiple independent subsystems with no dependency between them, it must either split them into separate sprints or explicitly explain why they must ship together.
7. **Schema migration coverage**
   - If storage/schema definitions change, the plan must include required migration or equivalent persistence update work and a verification command.
8. **UI state coverage**
   - If frontend UI changes are included, loading, empty, error, and success states must be explicitly covered or marked out of scope with a reason.
9. **Diagnosis loop coverage**
   - If the plan fixes a bug, regression, CI failure, or runtime error, it must include the reproduction command or a concrete reason reproduction is currently impossible.
10. **TDD slice coverage**
   - If the plan changes behavior, the first vertical slice must name the public behavior to verify and the focused command or executable feedback loop that will prove RED/GREEN.
11. **Test seam coverage**
   - If a correct test seam is unavailable, the plan must state the fallback feedback loop and record the seam gap as a risk or deferred item.

## Recommended Output

Design Validator or the orchestrator should summarize the gate as:

```markdown
### Plan Quality Gate
| Check | Result | Evidence |
|-------|--------|----------|
| No placeholders | PASS/WARN/FAIL | {evidence} |
| Exact file paths | PASS/WARN/FAIL | {evidence} |
| Verification commands | PASS/WARN/FAIL | {evidence} |
| Expected results | PASS/WARN/FAIL | {evidence} |
| Observable AC | PASS/WARN/FAIL | {evidence} |
| Scope decomposition | PASS/WARN/FAIL | {evidence} |
| Schema migration coverage | PASS/WARN/N/A | {evidence} |
| UI state coverage | PASS/WARN/N/A | {evidence} |
| Diagnosis loop coverage | PASS/WARN/N/A | {evidence} |
| TDD slice coverage | PASS/WARN/N/A | {evidence} |
| Test seam coverage | PASS/WARN/N/A | {evidence} |

VERDICT: PASS | WARN | FAIL
```
