# Failure Taxonomy

Use these classes when Gap Detector identifies gaps between Product Spec and implementation.
Iterator uses this taxonomy to select the appropriate fix strategy.

## Classification Classes

### reference-noise

Spec contains overlays, callouts, annotations, outdated references, or non-implementable decorations. The implementation may be correct but the diff against the spec is misleading.

**Detection**: Does the PRODUCT_SPEC section for this Sprint contain elements that cannot or should not be implemented? (e.g., "see mockup", annotations, conditional requirements marked as out-of-scope)

### layout-mismatch

Spacing, sizing, alignment, hierarchy, or component structure differs from the spec. Only relevant when `HAS_UI_CHANGES == true`.

**Detection**: Do rendered UI components match the spec's described layout? Are CSS classes or styling approaches consistent with the existing codebase patterns?

### text-content-mismatch

Rendered text, labels, placeholders, counts, dates, error messages, or branded strings differ from the expected output.

**Detection**: Compare all user-facing strings in the diff against the PRODUCT_SPEC. Check for hardcoded Korean text with incorrect postpositions (이/가, 은/는, 을/를, 와/과).

### state-mismatch

The target route, page, or component renders a different fixture, auth state, seeded entity, toggle state, or viewport-dependent branch than the contract expects.

**Detection**: Does the implementation handle all states the spec requires? (loading, empty, error, success, edge cases)

### semantic-mismatch

The code may compile and render, but interaction rules, button destinations, validation behavior, API data transformations, or state transitions diverge from the spec.

**Detection**: Are the business logic and user interaction flows aligned with the PRODUCT_SPEC's acceptance criteria? Do API responses match the expected shape and semantics?

### preflight-missing-input

Required route bindings, fixtures, reference assets, environment prerequisites, or seed data are missing. The implementation cannot be verified until these are provided.

**Detection**: Does the code reference environment variables, files, or services that don't exist or aren't configured?

## Iterator Strategy Mapping

| Failure Class | Iterator Fix Strategy |
|--------------|----------------------|
| reference-noise | Clarify spec scope or adjust implementation scope to match the implementable subset |
| layout-mismatch | Focus on CSS, styling, component structure; check against existing codebase patterns |
| text-content-mismatch | Fix text strings, labels, messages; verify Korean postposition correctness |
| state-mismatch | Fix state management, fixture loading, auth conditions, viewport handling |
| semantic-mismatch | Fix business logic, interaction flows, data transformations, acceptance criteria |
| preflight-missing-input | Create missing prerequisites (env vars, fixtures, seed data, config files) |

## Priority Rule

**Fix the most leveraged cause first.** If multiple failure classes exist, address the one that would cascade-fix others. For example, a semantic-mismatch might be the root cause of a text-content-mismatch.
