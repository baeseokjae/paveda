# ADR 0002 Remaining Gap Audit

Date: 2026-06-11
Source: `docs/decisions/0002-external-feature-adoption.md`

## Summary

ADR 0002 has no Phase 4. Phase 1, Phase 2, and Phase 3 are the full stated roadmap.

Current implementation covers the broad surface area. Initial audit found several closure gaps; the first closure pass has now completed the highest-priority runtime gaps for interview events, plan events, instinct router integration, and provider frontmatter routing.

Overall status:

| Phase | Status | Notes |
|---|---|---|
| Phase 1 v0.2 | Mostly complete | Worktree and cost tracking are implemented. Interview and plan EventStore contracts now exist; remaining work is `/do` confidence integration and docs. |
| Phase 2 v0.3 | Mostly complete | 2-A~2-F exist. Auto-learning now affects routing and provider frontmatter is parsed; remaining work is drift/ontology confidence integration and docs. |
| Phase 3 v0.4+ | Complete | Review, completion gate, unstuck, and workers are implemented with regression tests. |

## Closure pass 1 completed

- G1: added `src/spec/interview.ts`, `spec.interview.round`, `spec.interview.converged`, route `maxRounds`, and tests.
- G2: added `src/plan/index.ts`, `PlanTask`, `GeneratedPlan`, `recordGeneratedPlan()`, and tests.
- G8: connected active/promoted high-confidence instincts to router pre-escalation and added lifecycle maintenance.
- G9: parsed `allowed-providers` / `prefer-provider`, routed skill frontmatter provider metadata, and added explicit provider fallback API.

Remaining highest-priority closure now starts at G6/G5 plus follow-up integration tests/docs for G1/G2/G8/G9.

## Closure pass 2 completed

- G6: `driftActionForProfile()` implements the profile-by-severity matrix (fast=none, standard=warn, strict=block, release=block), with full matrix tests.
- G5: `ontologyBoostedAmbiguityThreshold()` integrates ontology convergence status into spec-binding gate — converged = 2x threshold, stagnating = 1.3x, with test.
- G1 follow-up: `spec.interview.converged` events now feed into ambiguous-gate threshold via the same ontology mechanism.
- G2 follow-up: task-id lineage test added — `verifyRun()` with `--task` filter correctly scopes evidence by metadata task_id.
- Worktree test: EventStore replay assertion for `worktree.created` and `worktree.finish.preview` events added.

## Closure pass 3 completed

- G3 (worktree events): EventStore replay assertions added for created/finish events.
- G4 (cost/token status): `tests/status-cost.test.ts` covers SessionSummary cost fields; status markdown includes Duration column; cost guard tracks USD/tokens via `session.cost.summary`.
- G7 (semantic search): `paveda search --semantic --query --limit --since` wired through CLI and MCP; deterministic fallback documented as intentional v0.3 contract.
- G10 (Phase 3 docs/schema): All four items have regression tests; `review` stage is correctly runtime-only (not in manifest schema).

Remaining low-priority items:
- Status table lacks token column (tokens tracked in cost guard events, not SessionSummary).
- `docs/spec.md` / `docs/architecture.md` may not mention Phase 3 events/CLI — implementation and tests complete.
- Embedding-backed vector search deferred (deterministic fallback is the v0.3 contract).

## Closure pass 4 completed

- Token column: deferred — tokens tracked via `session.cost.summary` events; SQLite schema migration not warranted for this level of detail.
- Phase 3 docs: `docs/architecture.md` now has Phase 3 event table (5.1), cost tracking (5.2), semantic search (5.3), and CLI reference (§6). `docs/spec.md` now has §13 Phase 3 section covering completion gate, unstuck, workers, deterministic search, and cost tracking.
- Embedding deferred: documented in both architecture.md (5.3) and spec.md (13.4).

## Open Gaps

### G1 — 1-A Socratic Interview EventStore loop is not implemented

ADR requirement:

- `paveda route --skill specify --mode interview --max-rounds 15`
- EventStore events:
  - `spec.interview.round`
  - `spec.interview.converged`
- `/do` ambiguity gate uses `spec.interview.converged` as evidence.

Observed implementation:

- `src/router/index.ts` supports `RouteMode = "evaluate" | "interview" | "greenfield" | "brownfield"`.
- `src/cli.ts` parses route `--mode interview`.
- `assets/harness/skills/specify/SKILL.md` contains a Socratic interview process.
- `tests/router.test.ts` verifies interview mode bypasses ambiguity blocking.

Gap:

- No implementation records `spec.interview.round` or `spec.interview.converged`.
- No `--max-rounds` route option found in CLI wiring.
- No `/do`/verify gate reads `spec.interview.converged` as stronger ambiguity evidence.
- Skill text exposes interview flow, but not the exact ADR runtime contract/events.

Recommended closure:

1. Add a small `src/spec/interview.ts` module with deterministic event helpers:
   - `recordInterviewRound(store, input)`
   - `recordInterviewConverged(store, input)`
2. Add route CLI parsing for `--max-rounds` and include it in route decision output.
3. Extend ambiguity/spec-binding gate to accept a recent `spec.interview.converged` event as supporting evidence.
4. Add tests in `tests/phase1-adoption.test.ts` or `tests/router.test.ts` for the events and CLI mode metadata.

### G2 — 1-C Plan decomposition EventStore contract is missing

ADR requirement:

- `/plan` emits `plan.generated` with task array, dependency graph, estimated minutes.
- `paveda verify --run <run_id> --task task-1` supports task-level verification.
- `/do` executes plan tasks in dependency order.

Observed implementation:

- `assets/harness/skills/plan/SKILL.md` has a substantial plan-only pipeline.
- `src/execution/index.ts` accepts `options.task` for verification.
- CLI wires `verify --task`.

Gap:

- No `plan.generated` EventStore helper or writer was found.
- No typed plan task schema/module was found.
- No test asserts `plan.generated` payload shape, dependency graph, or task-level verification semantics.
- `/do` plan-task dependency-order execution is skill-level guidance rather than runtime-verifiable state.

Recommended closure:

1. Add `src/plan/index.ts` with `PlanTask`, `GeneratedPlan`, validation, and `recordGeneratedPlan()`.
2. Make `/plan` skill contract explicit in SKILL.md output section and/or CLI helper.
3. Make `verify --task` filter or annotate gates/evidence by task id, instead of only carrying an unused option.
4. Add tests for plan schema validation and `plan.generated` replay.

### G3 — 1-B Worktree implementation is strong, but event tests and dry-run semantics need tightening

ADR requirement:

- `paveda worktree create/list/finish`
- `worktree.created` / `worktree.finished` events
- deterministic port resolution
- create performs git worktree add, install, init when `--write`.

Observed implementation:

- `src/worktree/index.ts` implements create/list/finish.
- `src/cli.ts` wires `worktree create/list/finish`.
- `src/worktree/index.ts` records `worktree.created`, `worktree.create.preview`, `worktree.finished`, and `worktree.finish.preview`.
- `tests/worktree.test.ts` exists.

Gap:

- Existing tests should explicitly assert persisted `worktree.created` and `worktree.finished` EventStore events, not only returned `eventType`.
- `createWorktree()` records preview events even when `write` is false. This is useful but slightly different from a pure dry-run contract; the ADR only specified create event on real create.

Recommended closure:

1. Add replay assertions to `tests/worktree.test.ts` for created/finished events.
2. Decide whether preview events are intentional public contract. If yes, document them in CLI help/docs.

### G4 — 1-D Cost tracking is implemented, but docs/status contract should be checked

ADR requirement:

- Cost guard tracks USD and tokens.
- Env vars: `PAVEDA_COST_GUARD_MAX_USD`, `PAVEDA_COST_GUARD_MAX_TOKENS`.
- SessionStop emits `session.cost.summary`.
- `paveda status` displays Duration/Cost/Tokens/Tool Calls.

Observed implementation:

- `src/hooks/cost-guard.ts` handles cost/tokens.
- `src/core/index.ts` contains cost/tokens env config.
- `src/hook-runtime/index.ts` emits `session.cost.summary`.
- `tests/cost-guard.test.ts`, `tests/runtime-smoke.test.ts`, and adoption report tests cover integration.

Gap:

- Audit did not verify `paveda status` human output includes cost/tokens exactly as ADR states.
- Documentation/spec alignment may lag behind implementation.

Recommended closure:

1. Add/confirm a `status` formatting test for cost/tokens.
2. Update `docs/spec.md` and `docs/architecture.md` if they still describe cost guard as time/agent only.

### G5 — 2-A Ontology convergence lacks `/do` trust integration

ADR requirement:

- `spec.ontology.convergence` event.
- `/do` entry condition uses converged ontology event for added confidence.
- Integrate with stagnation detection / iteration fingerprints.

Observed implementation:

- `src/spec/ontology-convergence.ts` implements similarity, convergence, and `recordOntologyConvergence()`.
- `tests/phase2-adoption.test.ts` covers similarity/convergence/event.

Gap:

- No clear `/do` gate/score path consumes `spec.ontology.convergence` as confidence evidence.
- No confirmed `iteration_fingerprints.ontology_schema` persistence path.

Recommended closure:

1. Add a score/gate contribution for latest converged ontology event.
2. Extend iteration fingerprint metadata or add explicit ontology schema storage if needed.

### G6 — 2-C Drift measurement is implemented, but policy severity profile matrix is not explicit

ADR requirement:

- `contract diff-source` includes weighted `drift`.
- Policy tiers:
  - minimal: high warn
  - standard: medium warn
  - strict: low block
  - release: any block

Observed implementation:

- `src/policy/drift.ts` implements `measureDrift()`.
- `src/contract/compiler.ts` / `src/cli.ts` wire `contract diff-source`.
- `tests/phase2-adoption.test.ts` covers weighted drift calculation.

Gap:

- Audit did not find an explicit profile severity matrix for spec-binding drift matching the ADR table.
- Existing `verifySpecBinding()` blocks hash drift for strict/release, but weighted drift severity does not appear fully wired into policy action by profile.

Recommended closure:

1. Add explicit `driftActionForProfile(profile, severity)` or equivalent.
2. Cover minimal/standard/strict/release matrix in tests.

### G7 — 2-D Semantic search is deterministic fallback, not embedding-backed vector memory

ADR requirement:

- Optional embedding dependency or BLOB embedding column.
- `paveda search --semantic --top-k --since`.
- MCP tool `paveda.search_semantic`.

Observed implementation:

- `src/store/semantic-search.ts` provides deterministic token-vector semantic search.
- `src/cli.ts` imports `semanticSearchLedger`.
- `src/mcp/server.ts` / `src/mcp/executor.ts` include semantic search wiring.
- `tests/phase2-adoption.test.ts` covers semantic search.

Gap:

- No embedding dependency/BLOB storage exists; implementation is dependency-free fallback.
- CLI uses project conventions and likely `--top-k`/`--since`, but the audit found `top-k` string mismatch in quick scan, so flags should be verified and tested explicitly.
- If fallback-only is intentional, document it as v0.3 deterministic fallback and defer embedding provider.

Recommended closure:

1. Add CLI test for `search --semantic --top-k 5 --since 30d`.
2. Add docs noting deterministic semantic fallback and optional embedding provider as future enhancement.
3. If ADR strict compliance is desired, add optional embedding provider interface without pulling heavy deps by default.

### G8 — 2-E Auto-learning exists, but router integration and lifecycle automation are incomplete

ADR requirement:

- `paveda instincts auto-extract --scope project --since 30d` etc.
- Extract router/policy patterns.
- PAL Router pre-escalates from active instincts, e.g. `requires_standard`.
- Lifecycle automation: TTL auto-expire, confidence demote, mismatch reevaluation.
- EventStore `instinct.auto_extracted`.

Observed implementation:

- `src/learning/auto-extract.ts` implements `autoExtractInstincts()` and records `instinct.auto_extracted`.
- `src/cli.ts` imports/wires auto-extract.
- `src/store/index.ts` has `instincts` table and status handling.
- `tests/phase2-adoption.test.ts` covers candidate extraction.

Gap:

- `src/router/index.ts` does not consume active instincts for pre-escalation.
- Extracted outcomes are `requires_same_tier` / `requires_escalation_review`, not ADR's `requires_standard` style routing signal.
- Lifecycle is mostly TTL expiry in store; confidence demote and 3-mismatch pending reevaluation were not found.

Recommended closure:

1. Extend `routeSkill()` input to accept active instincts or a resolver callback.
2. Add pre-escalation rule for high-confidence active instincts.
3. Add lifecycle maintenance helper: expire/demote/reopen pending based on confidence/mismatches.
4. Add tests for router + active instinct → standard/frontier tier.

### G9 — 2-F Multi-provider routing is mostly implemented but frontmatter and fallback API need closure

ADR requirement:

- Provider pools via `PAVEDA_PROVIDER_POOL_*`.
- Skill frontmatter fields:
  - `allowed-providers`
  - `prefer-provider`
- Router decision includes provider and available providers.
- Fallback on failed provider.

Observed implementation:

- `src/router/providers.ts` has default pools, env pool parsing, `selectProvider()`, preferred/allowed/failed provider handling.
- `src/router/index.ts` includes `provider`, `availableProviders`, and `providerReason` in decisions.
- `tests/phase2-adoption.test.ts` covers preferred provider selection and route decision provider.

Gap:

- `SkillFrontmatter` does not expose normalized `allowedProviders` / `preferProvider` fields, and audit did not find parsing of YAML `allowed-providers` / `prefer-provider` into route input.
- There is no explicit exported `handleProviderError()` API; fallback exists as `failedProvider` handling in `selectProvider()`.
- Router decision naming is camelCase (`availableProviders`) rather than ADR JSON example `available_providers`; this is probably OK internally, but CLI/EventStore JSON compatibility should be checked.

Recommended closure:

1. Parse `allowed-providers` and `prefer-provider` in `skill-loader` frontmatter normalization.
2. Pass those skill metadata fields into `routeSkill()` at CLI route time.
3. Add tests for frontmatter → route decision provider constraints.
4. Optionally export `handleProviderError()` wrapper for explicit ADR API parity.

### G10 — Phase 3 is functionally complete; docs/contracts may need alignment

ADR requirement:

- 3-A review stage/events
- 3-B completion verification gate
- 3-C `/unstuck`
- 3-D workers

Observed implementation:

- `src/execution/index.ts`: review stage, evidence kinds, `review.stage`, `review.severity`.
- `src/hooks/completion-gate.ts` and `src/hook-runtime/index.ts`: completion gate and `session.completion_gate`.
- `assets/harness/skills/optional/unstuck/SKILL.md`: optional unstuck skill.
- `src/worker/index.ts` and CLI: schedule/list/run/logs + `worker.run`.
- `tests/phase3-adoption.test.ts` covers all four.

Gap:

- The implementation is complete enough for code/test. Remaining work is mostly docs/contract alignment:
  - CLI help is updated, but `docs/spec.md` and `docs/architecture.md` should mention new events and worker command group.
  - `tests/contract-assets.test.ts` profile manifest types still show stages as `mechanical | semantic | consensus`; if manifest schema should know `review`, update contract asset tests/schema.

Recommended closure:

1. Update docs/spec/architecture with Phase 3 events and CLI.
2. Decide whether `review` belongs in profile manifests or remains runtime-only. If manifest-level, update contract assets/tests.

## Recommended Closure Order

1. G1 — Interview EventStore loop and `--max-rounds`.
2. G2 — Plan generated schema/event and task-level verify semantics.
3. G8 — Auto-learning router integration/lifecycle.
4. G9 — Provider frontmatter parsing and routing constraints.
5. G6 — Weighted drift profile action matrix.
6. G5 — Ontology convergence confidence integration.
7. G3/G4/G7/G10 — tests/docs alignment and explicit CLI coverage.

## Verification Baseline

The last full verification before this audit passed:

```text
pnpm typecheck && pnpm lint && pnpm test
51 test files passed, 429 tests passed
```

This audit did not modify runtime code.
