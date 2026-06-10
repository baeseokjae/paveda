# Paveda Next Design Spec

Status: accepted direction
Date: 2026-06-09

## Summary

Paveda is a universal contract, ledger, scoring, verification, and learning layer for agent hosts such as Claude Code, Codex, Pi, and Hermes.
Paveda does not replace host-native workflows, goals, loops, planners, or model execution.
It enforces a portable execution contract and records auditable evidence while each host continues to use its native primitives.

The refactor is intentionally breaking.
The canonical policy source is `.paveda/` plus package contract/assets.
Host-native files such as `.claude/`, `.codex/`, `CLAUDE.md`, and `AGENTS.md` are generated projections.

## Goals

- Preserve host-native execution philosophy.
- Enforce one universal contract across hosts.
- Require unit/e2e gates for code-changing tasks.
- Block missing required capability instead of silently downgrading.
- Maintain a portable execution ledger with evidence and artifacts.
- Provide strict scoring with auditable pass/block criteria.
- Support self-learning only when evidence-backed and reviewable.
- Make projection drift explicit and auditable.

## Non-Goals

- Do not build a host replacement, swarm scheduler, or model provider layer.
- Do not keep v1 compatibility as a design constraint.
- Do not auto-migrate `.harness` into `.paveda`.
- Do not silently overwrite host-native files.
- Do not allow learning, override, or profiles to relax required gates or score thresholds.

## Canonical Sources

Canonical sources are:

- `.paveda/contract.json`
- `.paveda/capabilities.json`
- `.paveda/test-policy.json`
- `.paveda/hosts/*.json`
- package assets under `assets/harness/contracts/**`
- package host declarations under `assets/harness/hosts/**`

Generated projections include:

- `.claude/`
- `.codex/`
- `.pi/`
- `.hermes/`
- `AGENTS.md`
- `CLAUDE.md`

Projection drift blocks by default.
The user must choose `import`, `regenerate`, or `approve-override`.
CI/headless mode fails on drift and never resolves it automatically.

## Contract Assets

PR 1 creates the contract canonical source:

```text
assets/harness/contracts/
  universal-contract.v1.json
  profiles/
    fast.json
    standard.json
    strict.json
    release.json
  schemas/
    contract.schema.json
    capabilities.schema.json

assets/harness/hosts/
  claude-code.json
  codex.json
  pi.json
  hermes.json
```

Machine-readable policy sources are JSON validated by JSON Schema.
YAML authoring can come later, but build must normalize it into canonical JSON.

Validation uses `ajv`.
Machine manifests use `additionalProperties: false` by default.
Extensions are allowed only through explicit `metadata`, `x-*`, or `extensions` fields.

Every manifest includes:

- `schemaVersion`
- `contractVersion`
- `minimumPavedaVersion`

Unknown major versions and unmet `minimumPavedaVersion` block early.
Known major plus newer minor/patch versions are handled through migration or a compatibility table.

## Universal Contract

`universal-contract.v1.json` contains:

- `id`
- `schemaVersion`
- `contractVersion`
- `minimumPavedaVersion`
- `description`
- `profiles`
- `phaseGraph`
- `taskTypes`
- `scoreMetrics`
- `evidenceResults`
- `gates`
- `capabilityRequirements`
- `projectionRules`
- `overridePolicy`
- `learningPolicy`

Validation has two layers:

- JSON Schema validation for shape, enum, required fields, and unknown fields.
- Semantic validation for graph cycles, reference integrity, profile consistency, capability matching, and release support.

## Phase Graph

`phaseGraph` is a DAG with a default linear happy path.

Fields:

- `nodes`
- `edges`
- `happyPath`
- `entryPhase`
- `terminalPhases`
- `repairEdges`

Default happy path:

1. `intake`
2. `clarify`
3. `plan`
4. `execute`
5. `score`
6. `unit-test`
7. `e2e-test`
8. `semantic-adversarial-verification`
9. `repair`
10. `handoff`

Phase node fields:

- `id`
- `label`
- `kind`
- `required`
- `hostPrimitivePreference`
- `requiredCapabilities`
- `inputs`
- `outputs`
- `requiredEvidence`
- `scoreImpacts`
- `failurePolicy`

Phase edge fields:

- `from`
- `to`
- `condition`
- `type`
- `allowedProfiles`
- `requiresEvidence`
- `recordsDecision`
- `maxAttempts`

Edge `type` is one of `normal`, `repair`, `block`, `terminal`.
Repair edges require `maxAttempts`.

## Profiles And Gates

Profiles:

- `fast`
- `standard`
- `strict`
- `release`

`/do` defaults to `strict`.
MVP implements `fast`, `standard`, and `strict`.
`release` exists as schema and conformance placeholder only.

Profile manifest fields:

- `profile`
- `schemaVersion`
- `contractVersion`
- `minimumPavedaVersion`
- `description`
- `extends`
- `scoreThresholds`
- `requiredGates`
- `verificationLadder`
- `overridePolicy`
- `notApplicablePolicy`
- `releaseSupport`

Required gate fields:

- `id`
- `phase`
- `evidenceKind`
- `requiredForTaskTypes`
- `conditionalWhen`
- `capability`
- `missingCapabilityBehavior`
- `notApplicablePolicy`
- `failureBehavior`
- `repairAllowed`
- `releaseOverrideAllowed`

Strict defaults:

- Code/ui/api/data/mixed task unit gate blocks on missing capability.
- Unit gate cannot be `not_applicable` for code-changing tasks.
- E2E gate is required for user-visible behavior or system boundary changes.
- Required gate failure goes to repair, then block.
- Score threshold override is not allowed.

Release placeholder:

- `releaseSupport.status: "not_supported_in_mvp"`
- `releaseSupport.suggestedProfile: "strict"`
- running `--profile release` blocks before execution
- output includes reason, unimplemented gates, suggested profile, and strict rerun command

## Evidence

Evidence result enum:

- `pass`
- `fail`
- `block`
- `not_applicable`
- `inconclusive`

`skip` is forbidden.

Evidence kind enum:

- `command`
- `unit_test`
- `e2e_test`
- `integration_test`
- `coverage`
- `typecheck`
- `lint`
- `build`
- `semantic_review`
- `adversarial_review`
- `risk_review`
- `security_scan`
- `screenshot`
- `trace`
- `manual_decision`
- `host_event`

`requiredEvidence` fields:

- `id`
- `kind`
- `requiredForProfiles`
- `resultPolicy`
- `providerCapability`
- `artifactTypes`
- `scope`
- `notApplicableAllowed`
- `notApplicableRationaleRequired`
- `redactionRequired`
- `ledgerFields`

`resultPolicy` fields:

- `acceptedResults`
- `blockingResults`
- `requiresArtifact`
- `requiresCommand`
- `requiresExitCode`
- `requiresRationale`
- `flakyHandling`
- `passRequiresDirectEvidence`

Strict required evidence accepts `pass` by default.
`not_applicable` is allowed only when explicitly enabled and evidence audit accepts the rationale.
Flaky or indirect evidence is `inconclusive`, not pass.

## Testing Policy

Code-changing tasks cannot skip unit/e2e gates.

Docs-only and metadata-only changes may mark unit/e2e as `not_applicable` with:

- rationale
- changed files
- classifier reason
- risk check result
- `approved_by`

If test infrastructure is missing, Paveda blocks and asks whether to add minimum test infrastructure.
If approved, Paveda creates a separate setup sprint before the original task proceeds.

Strict broad verification requires:

- lint
- typecheck
- test
- build
- coverage evidence

Missing command is capability missing/block unless project test policy explicitly declares it not applicable.

## Scoring

First-class metrics:

- `ambiguity_score`
- `plan_quality_score`
- `progress_score`
- `match_score`
- `verification_score`
- `risk_score`

Strict thresholds:

- `ambiguity_score <= 0.15`, block above `0.2`
- `plan_quality_score >= 0.9`
- `match_score >= 0.95`
- `verification_score = 1.0`
- `risk_score <= 0.2`, block or strengthen adversarial review above `0.3`

Contract metric definition fields:

- `id`
- `direction`
- `range`
- `description`
- `inputs`
- `calculation`
- `requiredEvidence`
- `ledgerField`

Profile threshold fields:

- `metric`
- `pass`
- `warn`
- `block`
- `repairTrigger`
- `overrideAllowed`

`calculation.kind` enum:

- `evidence_ratio`
- `threshold_check`
- `weighted_inputs`
- `manual_review`
- `risk_rule`
- `direct_gate_result`

No arbitrary code, JavaScript expression, or external DSL is allowed in contract assets.

## Capabilities

MVP capability ids:

- `goal.native`
- `workflow.native`
- `loop.native`
- `hook.lifecycle`
- `wrapper.lifecycle`
- `ledger.write`
- `artifact.write`
- `command.run`
- `test.unit`
- `test.e2e`
- `test.coverage`
- `browser.run`
- `semantic.review`
- `risk.review`
- `security.scan`
- `projection.write`
- `projection.drift`
- `learning.propose`

Contract capability definition fields:

- `id`
- `category`
- `description`
- `requiredBy`
- `evidenceKinds`
- `missingBehavior`
- `fallbackPolicy`

Host capability entry fields:

- `id`
- `support`
- `confidence`
- `source`
- `nativePrimitive`
- `limitations`
- `requiresSetup`
- `setupSprintAllowed`

Unknown capability ids fail validation.
Missing required capability blocks unless a safe fallback setup sprint is approved by the user.

## Host Declarations

Host declaration fields:

- `host`
- `schemaVersion`
- `declarationVersion`
- `minimumPavedaVersion`
- `displayName`
- `supportLevel`
- `versionConstraints`
- `capabilities`
- `unsupportedCapabilities`
- `lifecycleCapture`
- `projectionTargets`
- `eventMappings`
- `commandMappings`
- `policyConstraints`
- `knownQuirks`
- `conformanceFixtures`

MVP support levels:

- Claude Code: deep
- Codex: deep
- Pi: shallow
- Hermes: shallow

Host adapter responsibilities:

- discovery
- install/projection setup
- normalization
- lifecycle capture
- doctor/readiness

Host adapters do not execute models or replace native planners.

## Ledger And Artifacts

MVP uses SQLite:

```text
.paveda/ledger/paveda.db
.paveda/artifacts/<run_id>/
```

Primary tables:

- `runs`
- `phases`
- `phase_events`
- `scores`
- `evidence`
- `artifacts`
- `capabilities`
- `host_events`
- `decisions`
- `learning_patterns`
- `policy_violations`

`run_id` is UUID v7 and is the immutable top-level id.
Host session ids are secondary.

Raw stdout/stderr, screenshots, traces, test reports, coverage reports, and semantic reviews are stored as artifacts.
Ledger stores structured summaries plus artifact path/hash references.

Artifacts are redacted before storage.
Redaction failure blocks pass evidence when redaction is required.

## Host Adapter Mapping

Claude Code:

- workflow start maps to `run.started` or `phase.started`
- loop iteration maps to `attempt_id` or `phase_events`
- tool calls map to `host_events`
- subagent/task usage maps to `host_events` and `phases.host_mapping`
- workflow completion maps to `phase.completed` or `run.completed`
- generated `CLAUDE.md`/skills inject obligations but do not replace workflows

Codex:

- goal title maps to `runs.objective`
- goal details map to `runs.context`
- success criteria map to `runs.acceptance_criteria`
- plan/progress maps to `phase_events`
- native status maps to `host_events.normalized_status`
- Paveda score remains separate in `scores`

## CLI

Target CLI:

```text
paveda init --host <host>
paveda doctor --host <host>
paveda conformance --host <host>

paveda run <host> [--profile strict|release|standard|fast] -- <native args>
paveda do [--host <host>] [--profile strict] "<task>"
paveda verify [--run <id>] [--profile strict]
paveda status [--run <id>]
paveda evidence [--run <id>]
paveda learning list|propose|promote|retire|explain

paveda projection diff|regenerate|import|approve-override|status
paveda contract validate
paveda contract explain [--profile strict]
paveda capabilities --host <host>
```

`paveda do` creates a task-oriented Paveda run.
`paveda run` wraps an existing host-native command.
Both record `run_id`, capability snapshot, phase events, evidence, scores, decisions, and artifacts.

## Conformance

`paveda conformance` proves that a host/project can satisfy the universal contract.

Fixture fields:

- `id`
- `host`
- `profile`
- `task`
- `setup`
- `expected.result`
- `expected.events`
- `expected.evidence`
- `expected.artifacts`
- `assertions`

Required fixture coverage:

- code-changing task without unit/e2e evidence blocks
- docs-only task can pass with `not_applicable`
- score threshold miss triggers repair/block
- evidence audit rejects unsupported pass claims
- projection drift is detected
- release profile reports `not_supported_in_mvp`

## Self-Learning

Learning states:

1. `observed`
2. `candidate`
3. `validated`
4. `promoted`
5. `retired`

Promotion rules:

- `candidate`: at least one run evidence
- `validated`: at least three successful runs or equivalent manual evidence
- `promoted`: confidence `>= 0.9`, evidence audit pass, user approval
- user/shared scope promotion additionally requires redaction, review, and conformance

Learning cannot relax gates, thresholds, required evidence, or release restrictions.

## Implementation Roadmap

PR 1: Contract Assets And Validation

- add contract/profile/host JSON assets
- add JSON Schemas
- add `ajv`
- remove `.paveda` forbidden package check rule
- add package asset inclusion check
- add `tests/contract-assets.test.ts`
- validate schema, unknown fields, versions, graph, references, gates, score calculation kinds, release placeholder

PR 1 implementation status:

- `assets/harness/contracts/universal-contract.v1.json` exists.
- `assets/harness/contracts/profiles/{fast,standard,strict,release}.json` exist.
- `assets/harness/contracts/schemas/{contract.schema,capabilities.schema}.json` exist.
- `assets/harness/hosts/{claude-code,codex,pi,hermes}.json` exist.
- `ajv` is a runtime dependency because project-local policy validation runs outside tests.
- Machine manifests reject unknown fields by default and only allow explicit extension fields.
- `package:check` now requires contract/profile/schema/host assets in the package tarball.
- `.paveda/` is no longer forbidden package content.
- `tests/contract-assets.test.ts` validates schema shape and semantic contract invariants.
- Current package-level E2E gate is `pnpm package:check`, which builds the package tarball and runs packaged CLI smoke checks.
- Dedicated runner implementation, ledger rewrite, `/do` rewrite, adapters, and conformance runner remain out of PR 1.

PR 2: Ledger And Artifact Store

- replace v1 store schema with portable execution ledger
- add UUID v7 run ids
- add artifact path/hash storage
- add redaction status and policy violation records

PR 2 implementation status:

- EventStore schema version is now `2`.
- Existing session event tables still exist for current hook/runtime compatibility.
- New ledger tables exist: `runs`, `phases`, `phase_events`, `scores`, `evidence`, `artifacts`, `capabilities`, `host_events`, `decisions`, `learning_patterns`, `policy_violations`.
- Default project store path is `.paveda/ledger/paveda.db`.
- Default user store path is `~/.paveda/ledger/paveda.db`.
- `run_id` is generated as UUID v7 by default and non-v7 run ids are rejected.
- Raw artifacts are written below `.paveda/artifacts/<run_id>/`.
- Ledger artifact rows store relative path, sha256, byte length, kind, redaction status, and metadata.
- Evidence result validation accepts `pass`, `fail`, `block`, `not_applicable`, and `inconclusive`; `skip` is rejected.
- Decisions can record audited overrides with optional expiry.
- Learning pattern rows support `observed`, `candidate`, `validated`, `promoted`, and `retired`.
- Runtime smoke and package smoke now expect `.paveda/ledger/paveda.db`.
- CLI commands still expose the old command names until PR 4 rewrites the public contract flow.

PR 3: `.paveda` Init And Projection

- create `.paveda` source-of-truth layout
- add projection index
- add projection drift detection
- add projection diff/regenerate/import/approve-override/status

PR 3 implementation status:

- `paveda init --host <host> --write` now writes `.paveda/manifest.json`, `.paveda/contract.json`, `.paveda/capabilities.json`, `.paveda/test-policy.json`, `.paveda/profiles/strict.json`, `.paveda/hosts/<host>.json`, `.paveda/.gitignore`, and `.paveda/projections/index.json`.
- `.paveda/.gitignore` keeps runtime state out of the committed policy surface: `ledger/`, `artifacts/`, `state/`, `learning/cache/`, and `tmp/`.
- Projection index entries record host, projection path, projection kind, source manifest hash, source asset hashes, content hash, snapshot path, generator version, drift policy, and optional manual override id.
- Projection snapshots are written under `.paveda/projections/snapshots/<host>/` so `paveda projection diff` can show expected vs current file content without mutating files.
- `paveda projection status --host <host>` exits non-zero on missing or drifted projections.
- `paveda projection diff --host <host>` reports drift and recovery commands.
- `paveda projection regenerate --host <host> --write` regenerates host projections from packaged Paveda assets and refreshes the projection index.
- `paveda projection import --host <host> --path <file> --write` stores the explicit projection edit under `.paveda/hosts/<host>/imports/`, updates the expected hash, and clears drift.
- `paveda projection approve-override --host <host> --path <file> --reason <text> --expires-at <ISO> --write` records an audited override in the projection index and in the PR 2 ledger `decisions` table.
- Release profile projection execution blocks early with `not_supported_in_mvp`; Paveda does not silently downgrade to strict.
- Current package-level E2E now includes projection smoke: clean status, drift block, diff output, import resolution, and release early block.
- YAML authoring/normalization, full contract compiler, and host-specific sidecar headers remain out of PR 3.

PR 4: CLI Contract Flow

- redesign CLI commands
- add `paveda contract validate`
- add `paveda do`
- add `paveda run`
- add `paveda verify/status/evidence`

PR 4 implementation status:

- `paveda contract validate` validates `.paveda` contract source with AJV-backed schema checks for contract, profile, host declaration, capability entries, and required policy files.
- `paveda contract explain --profile <profile>` returns phase happy path, evidence results, required gates, score thresholds, verification ladder, and release support.
- `paveda capabilities --host <host>` reads host capability declarations from project overrides first and package declarations second.
- `paveda do` creates a UUID v7 ledger run, records capability snapshots, and records intake phase events. Codex now records a native `goal` handoff; hosts without deep start support still use `pending_adapter`.
- `paveda run <host> -- <native command>` wraps a native command, records command start/end host events, stores stdout/stderr artifacts, records command evidence, and completes or fails the run based on exit code.
- `paveda status --run <id>` returns ledger run summary with phase events, evidence, artifacts, scores, decisions, and policy violations.
- `paveda evidence --run <id>` lists evidence. `paveda evidence add` records explicit evidence using the same result enum as the universal contract.
- `paveda verify --run <id>` evaluates profile required gates against recorded evidence. With `--write`, it records verification score and blocking policy violations.
- Strict `e2e-gate` now includes `code` task type, so code-changing strict runs require both unit and e2e evidence.
- `release` profile execution for `do`, `run`, and `verify` blocks early with `not_supported_in_mvp`; Paveda does not silently downgrade to strict.
- `do` and `run` block before run start when projection drift is present.
- Package-level E2E now covers contract validate/explain, capabilities, do, missing-evidence verify block, evidence add, verify pass, status/evidence list, native run wrapper, and release early block.
- Full host adapter `startRun()`, conformance runner, and advanced evidence providers remain out of PR 4.

PR 5: `/do` And `/verify` Rewrite

- rewrite `/do` as host-native phase contract shell
- expand `/verify` into verification ladder
- enforce unit/e2e gates
- enforce strict score loop

PR 5 implementation status:

- `/do` is now a host-native contract shell. It starts from `.paveda` contract validation and projection drift checks, creates a ledger run with `paveda do`, then lets the host's native goal/workflow/loop execute the task.
- `/do` no longer describes an independent Paveda PDCA engine. It maps host-native work to Paveda phases and requires ledger evidence before handoff.
- `/verify` now describes the profile-driven verification ladder instead of a simple lint/test/build checklist.
- Runtime `verifyRun` now returns `gates[]`, `ladder[]`, `scoreSummary`, optional persisted `score`, and optional `policyViolations[]`.
- `verification_score` is computed as `(passed gates + valid not_applicable gates) / required gates`, then compared with the active profile threshold.
- Code-changing task types cannot satisfy unit/e2e gates with `not_applicable`. Missing, failed, blocked, or inconclusive evidence blocks.
- Docs and metadata/config-only tasks can satisfy test gates with audited `not_applicable` evidence only when rationale, classifier reason, and user approval metadata are present.
- Strict and release profile manifests now include docs/metadata for unit/e2e gates so non-testable work must record an explicit test non-applicability decision.
- Package-level E2E now covers code-task `not_applicable` blocking and docs-task audited `not_applicable` pass.
- Deep host adapter `startRun()`, conformance runner, and advanced evidence providers remain out of PR 5.

PR 6: Claude Code Deep Adapter

- add lifecycle hook capture
- add generated instruction/skill projections
- normalize Claude workflow/loop/tool events
- add Claude conformance fixtures

PR 6 implementation status:

- Claude Code hook payloads now normalize into `hostLifecycle` events with host, run id, phase id, event type, normalized status, and compact event payload.
- Run-aware Claude Code hooks record ledger `host_events` and `phase_events` when `paveda_run_id`, `run_id`, or `PAVEDA_RUN_ID` is present.
- `PostToolUse` Bash hooks create `command` evidence with command, exit code, pass/fail/inconclusive result, and Claude tool metadata.
- `status --run` now includes `hostEvents[]`, so lifecycle capture is visible in the run summary.
- Claude Code host declaration now lists `claude-hook-lifecycle-capture` and `claude-bash-command-evidence` conformance fixtures.
- Package-level E2E now sends a run-aware Claude Code hook payload through the packaged CLI and verifies host event plus command evidence in `status --run`.
- Full model/session start orchestration still stays host-native. Paveda captures and normalizes lifecycle events; it does not replace Claude Code workflows or loops.

PR 7: Codex Deep Adapter

- map Codex goal/objective/status
- preserve Codex native goal lifecycle
- add wrapper/conformance skeleton
- add Codex conformance fixtures

PR 7 implementation status:

- Codex has a dedicated adapter module that normalizes native goal statuses into Paveda host lifecycle events.
- `paveda do --host codex` now returns `hostNative.status = native_handoff`, `primitive = goal`, and records `codex.goal.created` in `host_events`.
- The Codex handoff preserves `run.objective`, `run.acceptance_criteria`, profile, task type, cwd, native status, and normalized status in the event payload.
- `phase_events` also records the Codex goal handoff, but Paveda scoring remains separate in `scores`.
- Codex host declaration now lists `codex-goal-lifecycle-handoff` and `codex-native-goal-status-mapping` conformance fixtures.
- Package-level E2E now verifies the packaged CLI creates and exposes Codex goal handoff events through `status --run`.

PR 8: Learning Lifecycle

- add learning list/promote/retire/explain
- add promotion thresholds and evidence audit
- add project-scope promoted knowledge files

PR 8 implementation status:

- Runtime now exposes `paveda learning list|propose|explain|promote|retire`.
- Learning proposals write to the `learning_patterns` ledger table and cannot be created as `promoted` or `retired` directly.
- `candidate` and `validated` learning require linked run evidence.
- Promotion is deliberately strict: project scope only in MVP, state must be `validated`, confidence must be `>= 0.9`, linked evidence is required, metadata must show `successfulRuns >= 3` or `manualValidation = true`, metadata must show evidence audit pass, and a user approval value is required.
- Learning policy rejects patterns that try to skip, bypass, disable, waive, or relax unit/e2e gates, score thresholds, required evidence, or release restrictions.
- `paveda learning promote --write` writes promoted project knowledge to `.paveda/learning/patterns.json`.
- `paveda learning retire --write` rewrites `.paveda/learning/patterns.json` from active promoted ledger rows instead of silently leaving retired patterns active.
- Package-level E2E now verifies propose, promote, explain, promoted knowledge file write, retire, and active knowledge removal through the packaged CLI.

PR 9: Conformance Runner

- add `paveda conformance --host <host>`
- run declared host conformance fixtures in isolated projects
- prove Claude Code and Codex deep support fixtures
- keep release profile execution blocked in MVP

PR 9 implementation status:

- Runtime now exposes `paveda conformance --host claude-code|codex|pi|hermes`.
- Conformance runs use isolated temporary fixture projects and do not mutate the caller's repository by default.
- Host declaration `conformanceFixtures[]` drives the runner; unknown fixture IDs fail instead of being ignored.
- Shared fixtures verify strict code-change unit/e2e blocking, docs-only audited `not_applicable`, projection drift blocking, and release `not_supported_in_mvp`.
- Claude Code fixtures verify lifecycle hook capture and Bash command evidence import.
- Codex fixtures verify native goal handoff capture and native status normalization.
- Package-level E2E now runs packaged CLI conformance for Codex and Claude Code.

## MVP Acceptance

MVP is accepted when:

- contract assets validate with `ajv`
- strict profile blocks code-changing tasks without unit/e2e evidence
- docs-only changes can pass with audited `not_applicable`
- release profile blocks with `not-supported-in-mvp`
- `.paveda` source-of-truth and projection drift detection work
- ledger records phases, evidence, scores, artifacts, host events, decisions, and policy violations
- Claude Code and Codex have deep lifecycle support
- Pi and Hermes have shallow declarations
- conformance runs for Claude Code and Codex

Current MVP acceptance status:

- All listed MVP acceptance items are now implemented in code, assets, CLI, tests, and package-level smoke.
- `release` remains intentionally non-executable in MVP and blocks with `not_supported_in_mvp`.
- Pi and Hermes remain shallow support declarations; deep lifecycle adapters are Phase 2 work.
- Unit tests and package-level E2E gates are required for code-changing Paveda work and are part of the verified package check.

## Versioning

This refactor is breaking.
Do not silently migrate v1 state or `.harness` files.

Release strategy:

- publish as a major or pre-major line
- keep package version and contract version separate
- allow `universal-contract.v1` to continue under a compatibility table
- require explicit re-init, import, regenerate, or override for old projections
