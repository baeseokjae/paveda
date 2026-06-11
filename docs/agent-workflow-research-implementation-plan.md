# Agent Workflow Research Implementation Plan

Status: draft
Date: 2026-06-10

## Summary

This document turns the research on Superpowers, Ouroboros, and Ruflo into a
Paveda implementation plan.

The goal is not to copy their product surfaces. Paveda should stay a portable
contract, policy, ledger, verification, and learning layer for agent hosts.
The useful ideas from these projects should be translated into Paveda-native
capabilities: spec-bound runs, staged verification, skill evals, stagnation
policy, setup UX, permissioned packs, and progress reporting.

## Source Projects

| Project | Primary concept | Useful signal for Paveda |
| --- | --- | --- |
| [Superpowers](https://github.com/obra/superpowers) | Agentic software development methodology built from composable skills | Strong workflow UX, TDD discipline, process-skill testing, subagent review gates |
| [Ouroboros](https://github.com/Q00/ouroboros) | Specification-first Agent OS for replayable AI coding workflows | Seed/spec contract, ambiguity gate, staged evaluation, event-sourced execution, stagnation recovery |
| [Ruflo](https://github.com/ruvnet/ruflo) | Multi-agent AI harness for Claude Code and Codex | Setup UX, plugin ecosystem, background workers, memory/learning, dashboard and verification surfaces |

## Current Paveda Fit

Paveda already has many adjacent primitives:

- `/specify` runs a Socratic interview and computes ambiguity.
- `/do` has Generator, Gap Detector, Iterator, personas, failure taxonomy, and
  TDD-oriented references.
- `verify`, evidence providers, release gates, artifact redaction, and JUnit-like
  reports already exist.
- EventStore records runs, phases, evidence, artifacts, decisions, learning, and
  policy violations.
- Host adapters normalize Claude Code, Codex, Pi, and Hermes lifecycle events.
- `pack`, `contract`, `projection`, `doctor`, `conformance`, and
  `adoption-report` already provide the foundation for auditable distribution.

The main gap is product coherence. The pieces exist, but Paveda does not yet make
the strongest path obvious:

```text
clarify intent -> bind run to contract -> execute through host -> collect evidence
-> evaluate in stages -> recover or handoff with an auditable ledger
```

## Product Direction

Paveda should position itself as:

> The portable policy and evidence runtime for agent workflows. It makes agent
> work auditable, enforceable, replayable, and host-neutral.

This keeps Paveda separate from the researched projects:

- Do not become a broad methodology pack like Superpowers.
- Do not market the core as an Agent OS unless the runtime contract, shell, and
  application/plugin layers are actually separated.
- Do not become a swarm scheduler or multi-agent memory platform like Ruflo.
- Do build the layer that those systems would need for policy-bound execution.

## Non-Goals

- Do not add a model provider layer.
- Do not implement a swarm scheduler.
- Do not build a web UI before the CLI/report surfaces are complete.
- Do not add a large marketplace before pack capability policy is enforceable.
- Do not make TDD an unconditional global policy for every task type.
- Do not allow learning, overrides, or packs to relax required gates.

## Implementation Roadmap

| Order | Work | Result |
| --- | --- | --- |
| 1 | Spec-bound runs | Every run can be tied to a stable spec/contract hash |
| 2 | Staged verification | Mechanical, semantic, and consensus/adversarial gates are explicit |
| 3 | Skill eval hardening | Skills are tested as process contracts, not only text assets |
| 4 | Stagnation policy | Repeated failed loops become first-class policy events |
| 5 | Setup UX | One command detects hosts and reaches a ready/partial/blocked state |
| 6 | Permissioned packs | Packs declare scoped capabilities and evidence requirements |
| 7 | Monitor/report surface | Users can inspect progress, evidence gaps, drift, and next actions |

## PR 1. Spec-Bound Runs

### Problem

Paveda has `/specify`, contract assets, acceptance criteria, and run records, but
`paveda do` is not yet strongly bound to an immutable task contract. A run can be
verified after the fact, but the execution path does not always prove which spec,
acceptance criteria, and ambiguity score governed the work.

### Goal

Every meaningful code-changing run should have a stable contract binding:

- objective
- task type
- acceptance criteria
- optional Product Spec path
- spec hash
- acceptance hash
- ambiguity score
- source contract/profile version

This binding becomes evidence for later policy checks, verification, and handoff.

### Design

Add a run binding object:

```ts
interface RunSpecBinding {
  bindingId: string;
  sourceType: "inline" | "spec_file" | "contract_source" | "host_goal";
  sourcePath?: string;
  specSha256?: string;
  acceptanceSha256: string;
  ambiguityScore?: number;
  contractVersion?: string;
  profile: PavedaProfile;
  createdAt: number;
}
```

Persist it in the ledger. Either add a dedicated `run_bindings` table or add a
versioned JSON column if the current ledger schema already has a run metadata
slot that is safe to extend.

### CLI Changes

- `paveda do --from-spec <path>`
- `paveda do --acceptance <a,b>` records `acceptanceSha256`
- `paveda do --ambiguity-score <n>` records the score from `/specify`
- `paveda status --run <id>` shows binding summary
- `paveda handoff --run <id>` includes binding hash and source

### Policy Changes

Add policy decisions:

- `workflow.spec-binding.missing`
  - warning in `fast`
  - block for code-changing tasks in `strict` and `release`
- `workflow.spec-binding.drift`
  - block when source file hash differs from recorded binding and no approved
    revision event exists
- `workflow.spec-binding.ambiguous`
  - block when ambiguity score exceeds profile threshold

### Tests

- Unit: binding hash is deterministic.
- Unit: inline acceptance criteria order is normalized or explicitly preserved.
- Integration: `paveda do --from-spec` records binding.
- Integration: `status` and `handoff` render binding.
- Policy: strict profile blocks missing binding for code tasks.
- Policy: release profile blocks spec drift.

### Completion Criteria

- A run can always answer: "What was this agent asked to build?"
- Handoff output includes a stable hash for the governing spec/acceptance data.
- Verification can fail a run because its spec changed without an approved
  revision.

## PR 2. Staged Verification Pipeline

### Problem

Paveda has verification gates and evidence providers, but the user-facing model is
still a single verification action. Ouroboros's staged model is useful because it
separates cheap deterministic checks from semantic judgment and expensive
multi-model consensus.

### Goal

Make verification stages explicit:

1. Mechanical
2. Semantic
3. Consensus or adversarial review

Each stage records independent evidence, score, blocking reason, and next action.

### Design

Add a verification stage result:

```ts
type VerificationStage = "mechanical" | "semantic" | "consensus";

interface VerificationStageResult {
  stage: VerificationStage;
  result: EvidenceResult;
  score?: number;
  confidence?: number;
  required: boolean;
  triggeredBy: string[];
  evidenceIds: number[];
  blockingPolicyViolationIds: number[];
  nextCommand?: string;
}
```

Stage behavior:

- Mechanical: lint, typecheck, build, test, coverage, static analysis.
- Semantic: acceptance criteria compliance, goal alignment, changed-surface
  drift, uncertainty.
- Consensus: required only by trigger matrix.

### Trigger Matrix

Consensus or adversarial review should run when any condition is true:

- profile is `release`
- risk surface includes `auth`, `payment`, `data`, `infra`, or `public-api`
- spec binding changed after run start
- semantic score is below threshold
- semantic confidence is low
- code changes public API behavior
- previous verification failed twice with different failure classes

### CLI Changes

- `paveda verify --run <id> --stage mechanical`
- `paveda verify --run <id> --stage semantic`
- `paveda verify --run <id> --stage consensus`
- `paveda verify --run <id> --collect --write` runs the stage ladder
- `paveda status --run <id>` shows each stage

### Contract Changes

Extend profile manifests with:

- `verificationStages[]`
- stage thresholds
- trigger matrix
- allowed `not_applicable` policies per stage

### Tests

- Mechanical stage fails fast when a required provider fails.
- Semantic stage can pass with valid review evidence.
- Consensus stage is not required for low-risk standard profile.
- Consensus stage is required for release/high-risk changes.
- Reports include stage-level results.

### Completion Criteria

- Verification output explains which stage failed.
- Expensive semantic/consensus review only runs when policy requires it.
- Release verification cannot pass with only mechanical evidence.

## PR 3. Skill Eval Hardening

### Problem

Paveda ships skills and eval files, but the eval model should prove that the skill
changes agent behavior. Superpowers's useful idea is "process documentation TDD":
show the agent fails without the skill, then passes with the skill.

### Goal

Treat every core skill as a process contract with pressure tests.

### Design

Add a skill eval schema:

```json
{
  "schemaVersion": 1,
  "skill": "do",
  "cases": [
    {
      "id": "requires-run-creation",
      "prompt": "...",
      "baselineExpectedFailure": "agent omits paveda do run id",
      "expectedWithSkill": [
        "paveda do",
        "run_id",
        "verify"
      ],
      "forbidden": [
        "claims completion without evidence"
      ]
    }
  ]
}
```

Add `paveda skills test <name>`:

- validates eval schema
- checks required/forbidden phrases or structured output where possible
- renders host-specific bundle and reruns static eval checks
- optionally runs model-backed eval only when configured

### Scope

Start with static and deterministic checks. Do not require LLM calls in
`pnpm release:check`.

### Tests

- Schema validation rejects unknown fields.
- `skills test do` fails when required contract text is missing.
- Host-rendered Codex/Claude/Hermes/Pi skills preserve required Paveda markers.
- Package smoke includes deterministic skill evals.

### Completion Criteria

- A broken `/do` or `/verify` instruction fails package smoke before release.
- Host rendering cannot silently remove required policy language.

## PR 4. Stagnation Policy

### Problem

Paveda already has stagnation scripts and personas in `/do`, but stagnation is not
yet a first-class runtime/policy concept. It lives mostly inside skill assets.

### Goal

Detect repeated failed loops from EventStore data and route them into policy and
recovery actions.

### Patterns

Support four patterns:

- `spinning`: same normalized output or diff hash repeats
- `oscillation`: A/B pattern repeats
- `no_drift`: verification score or failure fingerprint does not improve
- `diminishing_returns`: improvement rate falls below threshold

### Design

Add ledger records:

```ts
interface IterationFingerprint {
  runId: string;
  phaseId: string;
  iteration: number;
  outputHash?: string;
  diffHash?: string;
  failureFingerprint?: string;
  verificationScore?: number;
  taxonomy?: string[];
}
```

Add policy rule:

- `workflow.stagnation.recovery-required`

Actions:

- `require_step` in standard profile
- `deny` further blind iteration in strict/release when the same pattern repeats

### Recovery Routing

Map patterns to Paveda-native recovery:

| Pattern | Recovery |
| --- | --- |
| spinning | check test target, spec interpretation, and implementation hash |
| oscillation | require boundary/architecture review |
| no_drift | require research or new evidence |
| diminishing_returns | reduce scope or split task |

The existing iterator personas can remain skill-level assets, but the runtime
should emit the recovery requirement.

### CLI Changes

- `paveda progress --run <id>` shows stagnation state.
- `paveda status --run <id> --format markdown` includes recovery next action.
- `paveda evidence add` can attach iteration fingerprint metadata.

### Tests

- Spinning is detected from repeated hashes.
- Oscillation is detected from A/B/A/B fingerprints.
- Strict profile blocks another blind iteration after repeated stagnation.
- Progress output includes recovery action.

### Completion Criteria

- Paveda can explain why an agent loop is stuck.
- Stagnation recovery is auditable as a policy decision, not just prompt text.

## PR 5. Setup UX

### Problem

Paveda has `init`, host installers, `doctor`, `runtime-smoke`, and
`adoption-report`, but a new user must know which command to run first. Ruflo and
Ouroboros both provide stronger one-command onboarding.

### Goal

Add `paveda setup` as the recommended first-run command.

### Behavior

`paveda setup` should:

1. Detect installed host CLIs.
2. Recommend `lite` or `managed` install mode.
3. Run dry-run install plan.
4. With `--write`, install selected host bundle and hooks.
5. Run `doctor`.
6. Run `runtime-smoke` when safe.
7. Print a `ready`, `partial`, or `blocked` summary.

### CLI

```bash
paveda setup
paveda setup --host codex
paveda setup --host codex --mode lite
paveda setup --host codex --mode managed --write
paveda setup --all --write
```

### Output Shape

```json
{
  "status": "ready",
  "detectedHosts": ["codex", "claude-code"],
  "installedHosts": ["codex"],
  "doctor": { "ok": true },
  "nextCommand": "paveda do --host codex \"...\""
}
```

### Tests

- Detects host binaries from PATH fixtures.
- Dry-run writes no files.
- `--write` delegates to existing installers.
- Blocked doctor result exits non-zero only after write.
- Existing `init` behavior remains unchanged.

### Completion Criteria

- README quickstart can start with one command.
- A user sees exactly one next command after setup.

## PR 6. Permissioned Packs

### Problem

Paveda can build deterministic packs, but packs should become safer workflow
distribution artifacts. Ruflo's plugin ecosystem is useful, but Paveda should not
compete on plugin count. It should compete on capability scope and policy proof.

### Goal

Packs declare what they can do and what evidence they require.

### Manifest Extension

Add fields:

```json
{
  "capabilities": ["read", "write", "shell", "git", "mcp"],
  "riskSurfaces": ["infra", "data"],
  "requiredEvidence": ["unit_test", "semantic_review"],
  "requiredProfiles": ["strict", "release"],
  "publisher": "example",
  "signature": {
    "keyId": "example-key",
    "algorithm": "ed25519"
  }
}
```

### Policy

Install should block when:

- pack requires unsupported host capability
- pack declares a high-risk surface without required evidence
- pack signature is missing under a profile that requires signatures
- pack tries to relax gates, thresholds, or release restrictions

### CLI Changes

- `paveda pack inspect` shows capability and risk summary.
- `paveda pack verify` checks permission policy.
- `paveda pack install` prints required host capabilities before write.

### Tests

- Pack with unknown capability fails schema validation.
- Pack with `auth` risk and no security evidence fails policy validation.
- Signed pack metadata is preserved through build/inspect/install.
- Pack cannot modify profile thresholds downward.

### Completion Criteria

- Pack installation is a policy decision, not a blind file copy.
- Shared workflows can be reviewed before entering a project.

## PR 7. Monitor And Report Surface

### Problem

Paveda records useful data, but users need a compact way to inspect long-running
or failed work. A full web UI is premature. A CLI monitor and static report are
enough for now.

### Goal

Expose run state, evidence gaps, policy blocks, spec drift, verification stages,
and next commands in one place.

### CLI

```bash
paveda monitor --run <id>
paveda report --run <id> --markdown --write /tmp/paveda-report.md
paveda report --run <id> --html --write /tmp/paveda-report.html
```

### Report Sections

- Run summary
- Spec binding
- Phase timeline
- Verification stages
- Evidence table
- Artifact table
- Policy decisions
- Stagnation state
- Learning candidates
- Next command

### Tests

- Markdown report renders without missing required sections.
- HTML report escapes artifact paths and command output.
- Monitor can read active and completed runs.
- Release artifacts are marked immutable in reports.

### Completion Criteria

- A user can diagnose a blocked run without querying multiple commands.
- Reports are suitable for PR comments or CI artifacts.

## Documentation Updates

Update these docs as the PRs land:

- `README.md`
  - Replace the first quickstart path with `paveda setup`.
  - Add the primary loop: setup -> specify -> do -> verify -> handoff.
- `docs/spec.md`
  - Add run spec binding, staged verification, and stagnation policy sections.
- `docs/architecture.md`
  - Add verification pipeline and permissioned pack architecture.
- `docs/adoption.md`
  - Add setup mode decision table.
- `docs/release.md`
  - Add skill eval and staged verification release gates.

## Validation Strategy

Each PR should include targeted tests and then run:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Before release, run:

```bash
pnpm release:check
```

For documentation-only PRs, run at least:

```bash
pnpm lint
```

## Risks

### Product Scope Drift

The researched projects are broad. Paveda should not absorb every concept. Keep
the core limited to contract, policy, ledger, verification, projection, learning,
and host compatibility.

### Verification Cost

Semantic and consensus stages can become expensive. Use triggers and profiles so
low-risk work stays mechanical unless policy requires more.

### Host Compatibility Drift

Host-specific rendering can remove or weaken required instructions. Skill evals
must run against rendered bundles, not only canonical assets.

### Policy Fatigue

If every warning blocks work, users will bypass Paveda. Profiles should express
different strictness levels, but required gates and release restrictions must not
be weakened by learning or override.

## Open Questions → Resolved (2026-06-11)

- **Spec binding in `standard` profile**: standard profile does NOT block code tasks
  without spec binding. Progress shows the run is "unbound" but lets execution
  proceed. `fast` warns, `strict` and `release` block. This matches the current
  implementation.

- **Semantic verification**: Project commands are preferred first. When a project
  has no semantic review command, the host records manual review evidence via
  `paveda evidence add`. LLM review is performed by the host, not Paveda.
  Paveda evaluates the resulting evidence through contract thresholds.

- **Consensus: evidence kind vs verification stage**: Consensus is a verification
  stage (not a separate evidence kind). It is required only when trigger
  conditions are met (release profile, high-risk surfaces, spec drift, low
  semantic score/confidence, public API changes, repeated distinct failures).
  This matches the current implementation.

- **Multi-host setup default**: `paveda setup` detects installed host CLIs and
  chooses the first detected host as the default. `--all` installs for all
  detected hosts.

- **Pack signature**: Packs reuse the existing `policy bundle` Ed25519
  signature machinery. No separate pack signature envelope is needed.

## Recommendation

Start with PR 1 and PR 2. Spec-bound runs and staged verification create the
clearest product improvement and strengthen Paveda's identity. They also make the
later work easier: skill evals can target spec-bound behavior, stagnation can
attach to verification stages, packs can declare required evidence, and reports
can show the whole contract lifecycle.
