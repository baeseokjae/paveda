# Paveda Next Architecture Notes

이 문서는 Paveda 고도화 인터뷰에서 확정한 방향과 후속 구현 항목을 정리한다.
최종 설계 문서는 인터뷰를 더 진행한 뒤 별도로 작성한다.

## 목표

Paveda는 Claude Code, Codex, Pi, Hermes 같은 host를 대체하지 않는다.
각 host의 native workflow, goal, loop 철학을 보존하면서, 모든 host 위에 같은
contract, ledger, scoring, verification, learning 환경을 제공한다.

## 결정 로그

1. Paveda는 host를 대체하는 executor가 아니라, host-native 기능을 보존하는 compatibility/workflow overlay다.
2. Paveda는 universal contract만 강제하고, 각 phase의 실행 방식은 host-native primitive를 우선 사용한다.
3. `/do`는 Paveda 자체 실행 파이프라인이 아니라 host-native 실행을 감싸는 phase contract다. Unit/e2e gate를 필수 phase로 포함한다.
4. Code-changing task에서는 unit/e2e gate를 `SKIP` 처리하지 않고 block한다. 테스트 비대상 변경은 근거 있는 `not_applicable`로만 통과한다. 테스트 인프라가 없으면 setup sprint를 제안한다.
5. Paveda Store는 단순 로그가 아니라 host가 바뀌어도 실행을 재구성할 수 있는 portable execution ledger가 되어야 한다.
6. Host adapter는 discovery, install, normalization, capture, doctor/readiness를 책임진다. 모델 실행과 host-native planner 대체는 하지 않는다.
7. Score loop는 `ambiguity`, `plan_quality`, `progress`, `match`, `verification`, `risk` 6개 first-class metric으로 시작하고 기준은 엄격하게 둔다.
8. Scoring은 profile 기반으로 두되 `/do` 기본값은 `strict`다.
9. Verification은 `mechanical -> unit -> e2e -> semantic -> adversarial -> risk/security -> evidence audit` ladder로 구성한다.
10. 확장성은 plugin marketplace보다 먼저 `capability adapter + contract pack` 구조로 간다.
11. Required capability가 없으면 자동 downgrade하지 않고 block한다. 안전한 fallback이 있으면 사용자 승인 후 setup sprint로 추가한다.
12. Host/project가 universal contract를 실제로 지킬 수 있는지 검증하는 `paveda conformance`를 도입한다.
13. Universal contract는 versioned declarative manifest로 분리한다. `SKILL.md`는 agent-readable shell로 둔다.
14. Ledger에는 structured summary와 path/hash reference를 저장하고, raw evidence는 artifact store에 분리한다.
15. Host policy declaration과 contract compiler로 host-native workflow와 Paveda contract 충돌을 사전 감지한다.
16. Paveda는 operating memory를 넘어 auditable self-learning도 포함한다.
17. Self-learning은 proposal-first로 시작하고, 검증된 pattern만 auto-apply로 승격한다. Threshold나 required gate를 낮추는 학습은 금지한다.
18. Self-learning scope는 `run -> project -> user -> shared pack` 4단계로 나눈다.
19. 모든 host에서 공통 `Run Ledger Summary`와 `Phase Status`를 제공한다.
20. 인터뷰를 implementation roadmap까지 계속한 뒤, 마지막에 하나의 design spec으로 문서화한다.
21. MVP host 범위는 Claude Code와 Codex deep support, Pi와 Hermes shallow support다.
22. 구현 순서는 contract manifest, ledger schema, skill rewrite, adapters, conformance 순서로 간다.
23. 기존 v1 호환은 고려하지 않고 고도화 리팩토링으로 진행한다.
24. 기존 CLI 명령도 정리한다.
25. Host UI용 `/do` skill과 headless/CI용 `paveda do` CLI를 둘 다 제공한다.
26. `paveda do`는 직접 모델을 호출하지 않고 host adapter의 `startRun()`으로 host-native entrypoint를 시작한다.
27. Contract의 machine-readable canonical form은 JSON Schema 검증 가능한 JSON이다. 사람이 작성하는 contract pack은 YAML도 허용하되 build 단계에서 canonical JSON으로 normalize한다.
28. Contract phase graph는 DAG로 정의하고, 기본 contract는 선형 happy path를 제공한다.
29. Unit/e2e detection은 manifest 기반 명시 설정을 1순위, repo auto-detection을 2순위로 둔다. Auto-detection 결과는 confidence와 함께 ledger에 저장한다.
30. Paveda core config/state/artifacts는 `.paveda/`로 도입한다.
31. 기존 `.harness` 구조는 보존 제약으로 보지 않고, 명확성을 우선해 `.paveda` 중심으로 리팩토링한다.
32. Host-native 위치의 파일은 전부 generated projection이다. Canonical source는 `.paveda/`와 package contract/assets다.
33. Generated projection drift는 기본 block이다. 사용자가 명시적으로 import, approve-override, regenerate 중 하나를 선택해야 한다.
34. `.paveda` 정책/contract/config는 커밋 대상이고, runtime state/ledger/artifacts/learning cache는 기본 ignore다.
35. Self-learning 결과는 `learning promote`를 통해 reviewable project knowledge로 승격할 수 있다.
36. Override는 허용하지만 해제가 아니라 감사 가능한 예외로 기록한다. Release profile에서는 일부 override를 금지한다.
37. MVP에서는 `strict`까지 완성하고, `release`는 schema와 conformance placeholder만 둔다.
38. MVP에서 `--profile release`는 조용히 `strict`로 downgrade하지 않고 `not-supported-in-mvp`로 early block한다.
39. `run_id`를 최상위 불변 식별자로 둔다.
40. `run_id`는 UUID v7을 사용한다.
41. MVP는 SQLite 단일 파일을 유지하되 `.paveda/ledger/paveda.db`에 ledger 중심 schema를 새로 설계한다. Raw evidence는 `.paveda/artifacts/<run_id>/`에 둔다.
42. Phase 상태는 projection과 append-only history를 둘 다 저장한다. `phases`는 현재 상태, `phase_events`는 transition history다.
43. Evidence result enum은 `pass`, `fail`, `block`, `not_applicable`, `inconclusive`로 둔다. `skip`은 금지한다.
44. `not_applicable`은 deterministic task classifier가 제안하고, strict profile에서는 evidence audit이 검증한다. 애매하면 사용자 확인을 요구한다.
45. Task classifier는 `code`, `ui`, `api`, `data`, `infra`, `test`, `docs`, `metadata`, `mixed`를 산출한다.
46. E2E gate는 사용자-visible behavior 또는 system boundary를 건드리면 필수다.
47. Unit gate는 변경된 behavior를 직접 검증하는 focused unit test를 요구한다. 전체 test 통과만으로는 부족하다.
48. Strict profile에서는 bugfix와 new behavior에 red/green evidence를 요구한다.
49. Strict profile에서는 focused gate 이후 최소 `lint`, `typecheck`, `test`, `build` broad verification을 요구한다. 명령 없음은 자동 skip이 아니라 block이다.
50. Coverage는 strict에서 필수 evidence로 수집하되, 수치 threshold hard gate는 project policy에 위임한다. 변경 파일에 테스트 매핑이 없으면 block한다.
51. Codex goal은 Paveda `run.objective`와 `acceptance_criteria`로 import하고, Codex native 상태는 `host_events`와 `phases.host_mapping`에 저장한다. Paveda는 Codex goal 철학을 덮어쓰지 않는다.
52. Claude Code native workflow/loop는 Paveda phase 실행 primitive로 본다. Paveda는 hook과 generated instructions로 phase entry/exit/evidence를 capture한다.
53. Host policy declaration은 package 기본 선언 `assets/harness/hosts/<host>.json`과 project override `.paveda/hosts/<host>.json`으로 나눈다.
54. Runtime discovery 결과는 run 시작 시 capability snapshot으로 ledger에 고정한다.
55. Projection hash는 content hash와 source manifest hash를 둘 다 저장한다.
56. Generated file header는 가능한 파일에 넣고, parser-sensitive 파일은 sidecar metadata를 사용한다.
57. Projection drift 해결은 `paveda projection` 하위 명령으로 분리한다. `doctor`는 감지만 하고 수정은 명시 명령에서만 한다.
58. 첫 구현 PR은 contract assets, schemas, docs, validation tests, package asset inclusion tests까지만 포함한다. EventStore rewrite, CLI rewrite, `/do` rewrite, adapter, conformance runner는 후속 PR로 분리한다.
59. Contract/profile/host declaration schema 검증에는 `ajv`를 dev/runtime dependency로 추가해 사용한다. JSON Schema 검증기를 직접 구현하지 않는다.
60. Machine-readable canonical contract/profile/host declaration은 기본적으로 unknown field를 금지한다. 확장은 명시된 `metadata`, `x-*`, `extensions` 위치에서만 허용한다.
61. 모든 manifest에는 `schemaVersion`, `contractVersion`, `minimumPavedaVersion`을 둔다. Unknown major version은 early block하고, minor/patch는 migration 또는 compatibility table로 처리한다.
62. PR 1에서 `package-check.mjs`의 `.paveda` forbidden path/content 규칙을 제거한다. 대신 contract, profile, host declaration, schema asset inclusion을 검증한다.
63. PR 1 테스트는 `tests/contract-assets.test.ts`를 중심으로 둔다. Host policy semantics가 커지면 후속 PR에서 `tests/host-policy.test.ts`로 분리한다.
64. `universal-contract.v1.json` 최소 필드는 `id`, version fields, `description`, `profiles`, `phaseGraph`, `taskTypes`, `scoreMetrics`, `evidenceResults`, `gates`, `capabilityRequirements`, `projectionRules`, `overridePolicy`, `learningPolicy`로 둔다.
65. Host declaration 최소 필드는 `host`, version fields, `displayName`, `supportLevel`, `versionConstraints`, `capabilities`, `unsupportedCapabilities`, `lifecycleCapture`, `projectionTargets`, `eventMappings`, `commandMappings`, `policyConstraints`, `knownQuirks`, `conformanceFixtures`로 둔다.
66. Profile manifest 최소 필드는 `profile`, version fields, `description`, `extends`, `scoreThresholds`, `requiredGates`, `verificationLadder`, `overridePolicy`, `notApplicablePolicy`, `releaseSupport`로 둔다.
67. `phaseGraph`는 `nodes`, `edges`, `happyPath`, `entryPhase`, `terminalPhases`, `repairEdges`로 둔다. Schema는 node/edge 형태를 검증하고, 테스트는 cycle과 happy path edge 연결을 검증한다.
68. Phase node 최소 필드는 `id`, `label`, `kind`, `required`, `hostPrimitivePreference`, `requiredCapabilities`, `inputs`, `outputs`, `requiredEvidence`, `scoreImpacts`, `failurePolicy`로 둔다.
69. Phase edge 최소 필드는 `from`, `to`, `condition`, `type`, `allowedProfiles`, `requiresEvidence`, `recordsDecision`, `maxAttempts`로 둔다. `type`은 `normal`, `repair`, `block`, `terminal`로 제한하고, `repair` edge는 `maxAttempts`를 필수로 요구한다.
70. `requiredEvidence` 최소 필드는 `id`, `kind`, `requiredForProfiles`, `resultPolicy`, `providerCapability`, `artifactTypes`, `scope`, `notApplicableAllowed`, `notApplicableRationaleRequired`, `redactionRequired`, `ledgerFields`로 둔다.
71. Evidence `kind` MVP enum은 `command`, `unit_test`, `e2e_test`, `integration_test`, `coverage`, `typecheck`, `lint`, `build`, `semantic_review`, `adversarial_review`, `risk_review`, `security_scan`, `screenshot`, `trace`, `manual_decision`, `host_event`로 둔다.
72. Evidence `resultPolicy`는 `acceptedResults`, `blockingResults`, `requiresArtifact`, `requiresCommand`, `requiresExitCode`, `requiresRationale`, `flakyHandling`, `passRequiresDirectEvidence`로 둔다. Strict required evidence는 기본 `pass`만 accepted result로 인정한다.
73. MVP capability id는 `goal.native`, `workflow.native`, `loop.native`, `hook.lifecycle`, `wrapper.lifecycle`, `ledger.write`, `artifact.write`, `command.run`, `test.unit`, `test.e2e`, `test.coverage`, `browser.run`, `semantic.review`, `risk.review`, `security.scan`, `projection.write`, `projection.drift`, `learning.propose`로 시작한다.
74. Capability declaration은 contract definition과 host capability entry로 나눈다. Contract definition은 필요한 capability를 정의하고, host entry는 해당 host가 어떻게 제공하는지 선언한다.
75. Scoring schema는 contract의 metric definition과 profile의 threshold를 분리한다. Metric definition은 산출 방식을, profile threshold는 pass/warn/block/repair 기준을 선언한다.
76. Score metric `calculation`은 임의 코드나 expression DSL을 허용하지 않고, `calculation.kind` enum으로 제한한다.
77. Profile `requiredGates`는 `id`, `phase`, `evidenceKind`, `requiredForTaskTypes`, `conditionalWhen`, `capability`, `missingCapabilityBehavior`, `notApplicablePolicy`, `failureBehavior`, `repairAllowed`, `releaseOverrideAllowed`를 포함한다.
78. Release profile은 MVP에서 실행 불가 상태를 manifest로 표현한다. `releaseSupport.status`는 `not_supported_in_mvp`이고, 실행 요청은 early block한다.
79. Ledger schema는 `runs`, `phases`, `phase_events`, `scores`, `evidence`, `artifacts`, `capabilities`, `host_events`, `decisions`, `learning_patterns`, `policy_violations`를 1차 테이블로 둔다.
80. Contract schema 검증은 JSON Schema validation과 semantic validation을 분리한다. JSON Schema는 shape를 검증하고, semantic validation은 graph, reference, profile consistency를 검증한다.
81. Claude Code adapter v2는 workflow/loop를 대체하지 않고 hook, generated instruction, skill output contract로 phase/evidence를 capture한다.
82. Codex adapter v2는 Codex goal을 Paveda run objective/acceptance criteria로 연결하고, Codex native status와 plan/progress는 host event와 phase event로 보존한다.
83. `paveda do`는 task-oriented Paveda run을 만들고, `paveda run`은 host-native command를 ledger-aware wrapper로 실행한다.
84. `conformance` fixture는 JSON manifest로 정의하고, task, setup, expected events/evidence/result, assertions, required artifacts를 포함한다.
85. Evidence redaction은 artifact 저장 전에 수행한다. Redaction 실패나 secret 의심 artifact는 pass evidence로 인정하지 않고 block한다.
86. Learning promotion은 confidence threshold, 최소 성공 run 수, evidence audit, 사용자 승인을 요구한다. 학습은 gate/threshold를 완화할 수 없다.
87. Drift 해결 UX는 `diff`, `regenerate`, `import`, `approve-override`, `status`로 고정한다. Override는 ledger decision과 expiry를 요구한다.
88. `.paveda` gitignore 기본값은 policy/config/promoted learning은 커밋하고, ledger/artifacts/runtime state/cache는 ignore한다.
89. 이 리팩토링은 breaking refactor로 간다. v1 migration을 자동 수행하지 않고, 새 major/pre-major release와 explicit re-init/projection regeneration을 요구한다.

## 확정된 원칙

### Host 실행 모델

- Paveda는 host-native 실행을 대체하지 않는 compatibility/workflow overlay다.
- Paveda는 universal contract만 강제하고, 각 phase의 실행 방식은 host-native primitive를 우선 사용한다.
- Adapter는 discovery, install, normalization, capture, doctor/readiness를 책임진다.
- Adapter는 모델/provider 호출, swarm scheduler, host-native planner 대체를 하지 않는다.
- Hook이 있는 host는 hook으로 관측하고, hook이 약한 host는 `paveda run <host>` wrapper로 실행 전후 ledger event를 남긴다.

### `/do`와 `paveda do`

- `/do`는 Paveda 자체 실행 파이프라인이 아니라 host-native 실행을 감싸는 phase contract다.
- `paveda do` CLI도 제공한다. Host UI 밖, CI, headless 환경에서 같은 contract와 ledger를 사용한다.
- `paveda do`는 직접 모델을 호출하지 않고, host adapter의 `startRun()`을 호출한다.

`paveda do`와 `paveda run` UX:

- `paveda do`: Paveda task를 시작한다. Objective, task type, profile, acceptance criteria를 만들고 host adapter의 `startRun()`으로 host-native entrypoint를 호출한다.
- `paveda run`: 기존 host-native command를 Paveda ledger와 contract capture로 감싼다. Native args는 최대한 그대로 전달한다.
- 둘 다 `run_id`, capability snapshot, phase events, evidence를 기록한다.
- `do`는 task-oriented workflow에 적합하고, `run`은 CI/headless/native command wrapping에 적합하다.

권장 phase contract:

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

Phase graph는 DAG로 정의하고, 기본 contract는 선형 happy path를 제공한다.
`phaseGraph`는 다음 필드로 표현한다.

- `nodes`
- `edges`
- `happyPath`
- `entryPhase`
- `terminalPhases`
- `repairEdges`

Schema는 node/edge shape를 검증한다.
테스트는 graph가 cycle을 갖지 않는지, `happyPath`의 인접 phase가 실제 `edges`로 연결되는지 검증한다.

Phase node 최소 필드:

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

Paveda는 `hostPrimitivePreference`로 host-native 실행 방식을 우선 선택한다.
단, `requiredEvidence`, `scoreImpacts`, `failurePolicy`는 universal contract가 강제한다.
즉 실행 방식은 host가 정하더라도 phase별 의무와 실패 처리 기준은 Paveda가 검증한다.

Phase edge 최소 필드:

- `from`
- `to`
- `condition`
- `type`
- `allowedProfiles`
- `requiresEvidence`
- `recordsDecision`
- `maxAttempts`

`type`은 `normal`, `repair`, `block`, `terminal`로 제한한다.
`repair` edge는 `maxAttempts`를 반드시 가져야 한다.
`recordsDecision`이 true인 edge는 ledger `decisions`에 판단 근거를 남겨야 한다.
`requiresEvidence`가 있는 edge는 해당 evidence가 없으면 전이할 수 없다.
이 정책은 repair loop가 무한 반복되지 않게 하고 block/terminal 전이가 감사 가능하게 만든다.

`requiredEvidence` 최소 필드:

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

`notApplicableAllowed`는 docs/metadata 같은 테스트 비대상 변경에만 허용한다.
Code-changing task의 unit/e2e gate에서는 `notApplicableAllowed: false`를 기본값으로 둔다.
`notApplicableRationaleRequired`가 true이면 classifier reason, changed files, risk check result를 ledger에 남겨야 한다.
`redactionRequired`가 true이면 raw artifact 저장 전 redaction evidence를 요구한다.

Evidence `kind` MVP enum:

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

이 enum은 strict verification ladder의 required gates와 host-native capture를 모두 표현한다.
새 evidence kind는 contract version 또는 명시 extension policy를 통해 추가한다.

Evidence `resultPolicy` 최소 필드:

- `acceptedResults`
- `blockingResults`
- `requiresArtifact`
- `requiresCommand`
- `requiresExitCode`
- `requiresRationale`
- `flakyHandling`
- `passRequiresDirectEvidence`

Strict profile에서 required evidence의 `acceptedResults` 기본값은 `["pass"]`다.
`not_applicable`은 `notApplicableAllowed: true`이고 rationale와 evidence audit을 통과한 경우에만 허용한다.
`inconclusive`, `fail`, `block`은 strict required evidence를 통과시킬 수 없다.
`flakyHandling`은 flaky evidence를 `inconclusive`로 처리한다.
`passRequiresDirectEvidence`가 true이면 indirect evidence나 추정만으로 pass를 주장할 수 없다.

### Test Gate

- Code-changing task에서는 unit/e2e gate를 `SKIP` 처리하지 않고 block한다.
- Docs-only/config-only처럼 테스트 비대상 변경은 `not-applicable` 근거를 ledger에 기록하고 통과시킨다.
- 테스트 인프라가 없으면 Paveda가 최소 테스트 인프라 setup sprint를 제안한다.
- 사용자가 승인하면 setup sprint를 먼저 실행한다.
- Unit/e2e detection은 project manifest 명시 설정을 1순위, repo auto-detection을 2순위로 둔다.
- Auto-detection 결과는 confidence와 함께 ledger에 저장한다.
- Strict profile에서 detection confidence가 낮으면 사용자 확인을 요구한다.

### Scoring

Paveda score loop는 다음 6개 first-class metric을 사용한다.

- `ambiguity_score`
- `plan_quality_score`
- `progress_score`
- `match_score`
- `verification_score`
- `risk_score`

기준은 촘촘하고 엄격하게 둔다.

- `ambiguity_score <= 0.15` 권장, `> 0.2` block
- `plan_quality_score >= 0.9` 필수
- `match_score >= 0.95` 필수
- `verification_score = 1.0` 필수 required gates 전부 통과
- `risk_score <= 0.2` 권장, `> 0.3` block 또는 adversarial 강화
- Unit/e2e required gate는 pass가 아니면 block
- Flaky/indirect evidence는 pass로 인정하지 않음
- 같은 failure fingerprint가 2회 반복되면 자동 루프를 멈추고 사용자 판단을 요청

Contract `scoreMetrics` metric definition 필드:

- `id`
- `direction`
- `range`
- `description`
- `inputs`
- `calculation`
- `requiredEvidence`
- `ledgerField`

Profile `scoreThresholds` threshold 필드:

- `metric`
- `pass`
- `warn`
- `block`
- `repairTrigger`
- `overrideAllowed`

Contract는 metric의 의미, 입력, 계산 방식, ledger 저장 위치를 정의한다.
Profile은 같은 metric에 대해 pass/warn/block/repair 기준을 정의한다.
Strict profile에서는 `overrideAllowed: false`를 기본값으로 둔다.
Score threshold 완화는 override로도 허용하지 않는다.

Score metric `calculation.kind` MVP enum:

- `evidence_ratio`
- `threshold_check`
- `weighted_inputs`
- `manual_review`
- `risk_rule`
- `direct_gate_result`

PR 1에서는 score calculation에 임의 코드, JavaScript expression, external DSL을 허용하지 않는다.
Contract asset은 실행 가능한 코드가 아니라 evaluator가 지원하는 계산 방식만 선택한다.
Evaluator는 `calculation.kind`가 알려진 값일 때만 metric을 계산한다.

Profiles:

- `fast`
- `standard`
- `strict`
- `release`

`/do` 기본 profile은 `strict`다. MVP에서는 `fast`, `standard`, `strict`를 실제 동작 대상으로 삼고,
`release`는 schema와 conformance placeholder만 둔다.
사용자가 `--profile release`를 직접 요청하면 조용히 `strict`로 downgrade하지 않고 early block한다.
실행 결과는 `not-supported-in-mvp`로 중단하고, release profile이 요구하는 미구현 gate 목록,
현재 사용할 수 있는 가장 강한 profile인 `strict`, `--profile strict` 재실행 명령을 보여준다.
Conformance에서는 `release: not supported in MVP`로 표시한다.

Profile `requiredGates` gate 필드:

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

Strict profile 기본값:

- Code/ui/api/data/mixed task의 unit gate는 `missingCapabilityBehavior: "block"`이다.
- Code/ui/api/data/mixed task의 unit gate는 `notApplicablePolicy.allowed: false`다.
- User-visible behavior 또는 system boundary 변경의 e2e gate는 `missingCapabilityBehavior: "block"`이다.
- Required gate failure는 `failureBehavior: "repair_then_block"`이다.
- Score threshold override는 금지한다.

Release profile placeholder:

- `releaseSupport.status: "not_supported_in_mvp"`
- `releaseSupport.reason`: MVP에서 release 실행이 막히는 이유
- `releaseSupport.unimplementedGates`: release에서 필요한 미구현 gate 목록
- `releaseSupport.suggestedProfile: "strict"`
- `releaseSupport.rerunCommand`: strict 재실행 명령 템플릿

MVP에서 `--profile release`가 들어오면 실행 전 다음 정보를 출력하고 block한다.

- `not-supported-in-mvp`
- release profile이 요구하는 미구현 gate 목록
- 현재 사용할 수 있는 가장 강한 profile인 `strict`
- `--profile strict` 재실행 명령

### Verification Ladder

Paveda는 strict phase evaluation과 보안/관측/고급 검증을 섞은 Verification Ladder를 사용한다.

1. `mechanical`: lint, typecheck, build, static checks
2. `unit`: 변경 behavior와 관련된 unit test
3. `e2e`: 사용자-visible 또는 integration boundary가 있는 변경 검증
4. `semantic`: spec/acceptance criteria 대비 의미 검증
5. `adversarial`: edge case, permission, concurrency, large input, rollback
6. `risk-security`: secret, destructive op, migration, authz, data integrity, supply chain
7. `evidence-audit`: pass 주장이 실제 evidence로 증명되는지 검증

Profile별 필수 단계:

- `standard`: 1-4 필수, 5-7은 risk trigger 시
- `strict`: 1-4 필수, 5와 7 필수, 6은 trigger 시
- `release`: 1-7 전부 필수. MVP에서는 placeholder

### Ledger와 Artifact Store

기존 v1 호환은 고려하지 않는다. Paveda는 고도화 리팩토링으로 `portable execution ledger`를 새로 설계한다.

Core schema 후보:

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

Ledger table 필드 초안:

`runs`:

- `run_id`
- `run_slug`
- `objective`
- `acceptance_criteria`
- `profile`
- `task_type`
- `status`
- `host`
- `host_session_ids`
- `contract_version`
- `contract_hash`
- `capability_snapshot_hash`
- `started_at`
- `ended_at`
- `created_by`

`phases`:

- `run_id`
- `phase_id`
- `status`
- `attempt_id`
- `started_at`
- `ended_at`
- `host_mapping`
- `summary`
- `last_event_id`

`phase_events`:

- `event_id`
- `run_id`
- `phase_id`
- `attempt_id`
- `event_type`
- `from_status`
- `to_status`
- `reason`
- `timestamp`
- `evidence_id`
- `host_event_id`

`scores`:

- `score_id`
- `run_id`
- `phase_id`
- `metric`
- `value`
- `threshold_result`
- `profile`
- `inputs_hash`
- `evidence_ids`
- `created_at`

`evidence`:

- `evidence_id`
- `run_id`
- `phase_id`
- `kind`
- `result`
- `provider`
- `command`
- `exit_code`
- `duration_ms`
- `artifact_ids`
- `rationale`
- `redaction_status`
- `created_at`

`artifacts`:

- `artifact_id`
- `run_id`
- `kind`
- `path`
- `sha256`
- `size_bytes`
- `redaction_status`
- `retention_policy`
- `created_at`

`capabilities`:

- `snapshot_id`
- `run_id`
- `host`
- `capability_id`
- `support`
- `confidence`
- `source`
- `native_primitive`
- `limitations`
- `requires_setup`

`host_events`:

- `host_event_id`
- `run_id`
- `host`
- `host_session_id`
- `native_event_type`
- `normalized_event_type`
- `payload_ref`
- `timestamp`

`decisions`:

- `decision_id`
- `run_id`
- `phase_id`
- `decision_type`
- `reason`
- `actor`
- `scope`
- `expires_at`
- `evidence_ids`
- `created_at`

`learning_patterns`:

- `pattern_id`
- `scope`
- `status`
- `confidence`
- `supporting_run_ids`
- `description`
- `proposed_change`
- `approved_by`
- `created_at`
- `promoted_at`

`policy_violations`:

- `violation_id`
- `run_id`
- `phase_id`
- `policy`
- `severity`
- `message`
- `blocked`
- `evidence_ids`
- `created_at`

`run_id`를 최상위 불변 식별자로 둔다. 모든 phase, score, evidence, artifact,
host event, decision, learning event는 `run_id`에 귀속한다. Host session id는
보조 식별자다. 하나의 Paveda run이 여러 host-native session으로 나뉠 수 있기
때문에 host id를 canonical execution id로 쓰지 않는다.

식별자:

- `run_id`: Paveda portable execution id. UUID v7 사용
- `attempt_id`: repair/retry attempt id
- `phase_id`: contract phase id
- `host_session_id`: host-native session/goal/workflow id
- `evidence_id`: 개별 evidence id
- `artifact_id`: raw artifact id
- `pattern_id`: learning pattern id
- `contract_version`: contract source version/hash
- `run_slug`: 사람이 보는 짧은 식별자. `run_id`와 별도로 관리

MVP 저장소는 SQLite 단일 파일을 유지한다. 단, schema는 ledger 중심으로 새로
설계한다.

권장 경로:

```text
.paveda/ledger/paveda.db
.paveda/artifacts/<run_id>/
```

SQLite에는 metadata와 structured ledger를 저장하고, raw artifact는 파일 시스템에
저장한다. 후속으로 FTS5 검색, vector index, artifact retention/compaction을 검토한다.

Phase 상태는 projection과 append-only history를 모두 저장한다.

- `phases`: phase별 현재 상태 projection. `paveda status --run <id>` 같은 조회에 사용
- `phase_events`: phase transition history. 감사, 재현, self-learning, evidence audit에 사용

`phases` 필드 후보:

- `run_id`
- `phase_id`
- `status`
- `attempt_id`
- `started_at`
- `ended_at`
- `host_mapping`
- `summary`

`phase_events` 필드 후보:

- `run_id`
- `phase_id`
- `event_type`
- `from_status`
- `to_status`
- `reason`
- `timestamp`
- `evidence_id`
- `host_event_id`

Ledger에는 structured summary와 path/hash reference를 저장한다.
Raw evidence는 artifact store에 분리한다.

Ledger 저장:

- command, exit code, duration, started/ended time
- normalized result: pass/fail/block/not_applicable/inconclusive
- score values
- artifact path
- artifact sha256
- redaction status

Evidence result enum:

- `pass`: required evidence 충족
- `fail`: 실행했고 실패
- `block`: 실행 전 조건 미충족 또는 policy violation
- `not_applicable`: task type상 비대상. rationale 필수
- `inconclusive`: evidence가 불충분, flaky, partial, indirect

`skip`은 사용하지 않는다. Required gate는 `pass` 또는 근거 있는 `not_applicable`만 통과할 수 있다.
Strict profile에서 `fail`, `block`, `inconclusive`는 통과 불가다.

`not_applicable`은 deterministic task classifier가 제안하고, strict profile에서는 evidence audit이 검증한다.
애매하면 사용자 확인을 요구한다.

허용 가능한 예:

- docs-only: markdown 문서만 변경
- comments-only: 코드 동작 변화 없는 주석만 변경
- metadata-only: README badge, license, release note
- config-only 중 런타임 동작과 테스트 영향이 없는 경우

허용하면 안 되는 예:

- package/dependency 변경
- build/test config 변경
- schema/migration 변경
- auth/security/runtime config 변경
- UI/route/API/worker behavior 변경
- 작아 보이는 코드 변경

`not_applicable` 필수 필드:

- `rationale`
- `changed_files`
- `classifier_reason`
- `risk_check_result`
- `approved_by`: auto/user

`not_applicable`은 run-scoped only다. 영구 예외로 저장하지 않는다.

Evidence redaction:

- Raw artifact는 저장 전에 redaction한다.
- Secret pattern, token, API key, private key, cookie, authorization header, local credential path는 기본 redaction 대상이다.
- Redaction 결과는 `redaction_status`에 `not_required`, `redacted`, `failed`, `blocked` 중 하나로 저장한다.
- `redactionRequired: true` evidence에서 redaction이 실패하면 해당 evidence는 pass가 될 수 없다.
- Secret 의심 artifact를 raw로 저장해야만 pass할 수 있는 gate는 block한다.
- Redaction 전 원문은 ledger나 committed file에 저장하지 않는다.

Task classifier는 gate 결정에 필요한 타입만 산출한다.

Task type:

- `code`: 런타임 동작 변경 가능
- `ui`: 사용자-visible UI 변경
- `api`: request/response contract 변경
- `data`: schema, migration, persistence, serialization 변경
- `infra`: CI, deploy, env, container, build system 변경
- `test`: 테스트 코드/테스트 인프라 변경
- `docs`: 문서만 변경
- `metadata`: license, changelog, badge, repo metadata
- `mixed`: 여러 타입 또는 classifier confidence 낮음

Gate 기본값:

- `code`: unit required, e2e conditional
- `ui`: unit required, e2e required
- `api`: unit required, e2e/integration required
- `data`: unit required, migration/rollback/risk required
- `infra`: unit conditional, e2e conditional, risk required
- `test`: test self-validation required
- `docs`/`metadata`: unit/e2e `not_applicable` 가능
- `mixed`: strict에서는 가장 강한 gate 적용

E2E gate는 사용자-visible behavior 또는 system boundary를 건드리면 필수다.

E2E 필수:

- UI route/page/component interaction 변경
- API endpoint behavior 변경
- auth/permission/session flow 변경
- payment/billing/notification/email/webhook 같은 side effect
- worker/job/scheduler flow 변경
- database migration이 실제 read/write path에 영향
- CLI command UX 변경
- multi-service integration 변경

E2E 대체 가능:

- pure function/internal library 변경
- type-only refactor
- isolated service method with strong integration test
- test-only refactor

대체 조건:

- 왜 E2E가 과한지 rationale 필요
- integration/unit evidence가 실제 boundary를 충분히 커버해야 함
- strict profile에서는 evidence audit이 대체 타당성을 확인
- release profile에서는 대체 금지 또는 별도 승인 필요

Unit gate는 변경된 behavior를 직접 실패시키고 통과시키는 focused unit test를 요구한다.
단순히 전체 테스트 스위트가 통과하는 것은 unit gate evidence로 부족하다.

필수 조건:

- 변경된 behavior를 특정하는 테스트가 있어야 함
- 새 기능이면 새 테스트 또는 기존 테스트 확장 필요
- 버그 수정이면 재현 테스트가 먼저 실패해야 함
- refactor면 public behavior 보존 테스트가 있어야 함
- test-only 변경이면 test self-validation이 필요
- 전체 `test` 통과는 broad verification evidence이지 focused unit evidence가 아님

Strict 처리:

- focused unit evidence 없으면 `inconclusive` 또는 `block`
- "기존 테스트가 커버할 것 같음"은 pass 불가
- changed source와 대응 test mapping을 evidence에 저장
- 테스트를 추가하지 않는 경우 rationale과 evidence audit 필요

Strict profile에서는 bugfix와 new behavior에 red/green evidence를 요구한다.
모든 변경에 테스트 실패 커밋을 남기라는 뜻은 아니며, ledger에 테스트가 실패한 실행 결과와
이후 통과 결과를 저장하면 된다.

Red/green 정책:

- 새 기능: 새/수정 테스트가 구현 전 실패하거나, 최소한 구현 전 대상 assertion이 실패함을 증명
- 버그 수정: 재현 테스트가 수정 전 실패해야 함
- refactor: red evidence 대신 behavior preservation evidence 허용
- docs/metadata: `not_applicable`
- emergency override: 가능하지만 감사 가능한 예외로 기록

Red/green evidence:

- failing command
- failing test name
- failure excerpt
- pass command
- pass test name
- artifact hash
- attempt id

Focused unit/e2e가 통과한 뒤, strict profile에서는 broad verification으로 최소
`lint`, `typecheck`, `test`, `build`를 요구한다.
명령이 없는 경우 자동 `skip`하지 않고 capability missing/block으로 본다.
단, 언어/프로젝트 특성상 해당 gate가 무의미하면 contract/test-policy에 명시해야 한다.

기본 broad gates:

- lint
- typecheck
- full test suite
- build
- coverage summary

처리:

- script/command 없음: auto skip 금지
- project test-policy에 "이 repo는 typecheck 없음" 같은 명시 설정 필요
- auto-detection 실패: 사용자 확인
- command 실패: repair loop
- flaky: `inconclusive`, pass 불가

Coverage는 MVP strict에서 필수 evidence로 요구하되, 수치 threshold hard gate는 project policy에 위임한다.
단, 변경 파일에 테스트 매핑이 없으면 block한다.

Coverage 정책:

- coverage command/report 가능하면 수집 필수
- coverage command 없음: capability missing. 사용자가 test-policy에 명시해야 함
- changed source without mapped tests: block
- project가 threshold를 정의하면 hard gate 적용
- threshold 없으면 coverage는 evidence + warning/risk input

Artifact store 저장:

- raw stdout/stderr
- screenshots
- traces
- test reports
- coverage reports
- semantic/adversarial review output

민감정보는 저장 전 redaction한다.

### `.paveda` 중심 구조

기존 `.harness` 구조는 보존 제약으로 보지 않는다.
명확성을 우선해 `.paveda` 중심으로 리팩토링한다.

권장 구조:

```text
.paveda/
  contract.json
  capabilities.json
  test-policy.json

  skills/
  hooks/
  checks/
  context-modules/

  state/
  ledger/
  artifacts/
  learning/
  conformance/
```

Canonical source는 `.paveda/`와 package contract/assets다.
Host-native 위치의 파일은 전부 generated projection이다.

Generated projection 예:

- `.claude/`
- `.codex/`
- `.pi/`
- `.hermes/`
- `AGENTS.md`
- `CLAUDE.md`

Projection drift 정책:

- 기본은 block
- 사용자가 선택한 경우에만 `.paveda`로 import하거나 host-specific override로 승격
- Paveda는 조용히 덮어쓰지 않는다
- CI/headless에서는 drift를 fail로 처리

Projection hash는 projection file content hash와 source manifest hash를 둘 다 저장한다.

Projection metadata:

- `projection_path`
- `host`
- `source_contract_version`
- `source_manifest_hash`
- `source_asset_hashes`
- `content_hash`
- `generated_at`
- `generator_version`
- `projection_kind`: instruction/skill/context/config/hook
- `managed_by: paveda`
- `manual_override_id` optional

Generated file header에도 최소 metadata를 넣는다.
가능한 파일에는 header를 넣되, host parser가 민감한 파일은 sidecar metadata를 사용한다.

정책:

- Markdown/instruction files: HTML comment header 사용
- JSON/YAML config: host가 unknown key를 허용하면 `_paveda` metadata 사용
- Host가 unknown key를 싫어하면 sidecar 사용
- Skill metadata file이 parser-sensitive하면 sidecar 사용
- Binary/artifact는 sidecar only

Sidecar index:

```text
.paveda/projections/index.json
```

Projection drift 해결은 `paveda projection` 하위 명령으로 분리한다.
`doctor`는 감지만 하고 수정은 명시 명령에서만 한다.

권장 CLI:

```text
paveda projection diff --host codex
paveda projection regenerate --host codex
paveda projection import --host codex --path AGENTS.md
paveda projection approve-override --host codex --path AGENTS.md --reason "..."
paveda projection status --host codex
```

원칙:

- `doctor`/`conformance`: drift 감지와 recovery command 제안
- `regenerate`: `.paveda` source에서 host projection 재생성
- `import`: projection 변경분을 `.paveda` source로 반영
- `approve-override`: host-specific override로 ledger에 기록
- headless/CI에서는 drift 해결 자동 수행 금지

Drift command UX:

- `paveda projection diff`: source와 projection 차이를 보여준다.
- `paveda projection regenerate`: `.paveda` source에서 projection을 재생성한다.
- `paveda projection import`: projection 변경을 `.paveda` source로 승격한다.
- `paveda projection approve-override`: host-specific override를 생성하고 ledger decision을 남긴다.
- `paveda projection status`: drift와 override 상태를 조회한다.

Override 필수 정보:

- reason
- actor
- scope
- expiry
- affected projection path
- source manifest hash
- compensating control

Commit 정책:

- `.paveda` 정책/contract/config는 커밋 대상
- Runtime state/ledger/artifacts/learning cache는 기본 ignore
- Handoff/report export는 별도 경로로 커밋 가능

`.paveda` gitignore 기본 템플릿:

```gitignore
.paveda/ledger/
.paveda/artifacts/
.paveda/state/
.paveda/learning/cache/
.paveda/tmp/
```

기본 커밋 대상:

- `.paveda/contract.json`
- `.paveda/capabilities.json`
- `.paveda/test-policy.json`
- `.paveda/hosts/*.json`
- `.paveda/learning/patterns.json`
- `.paveda/learning/host-quirks.json`
- `.paveda/learning/test-strategies.json`
- `.paveda/learning/risk-rules.json`

Package check 정책:

- `.paveda`는 금지 대상이 아니라 Paveda canonical policy 구조다.
- 기존 `package-check.mjs`의 `.paveda` forbidden path/content 패턴은 제거한다.
- Package check는 `assets/harness/contracts/**`, `assets/harness/hosts/**`, schema 파일이 패키지에 포함되는지 검증한다.
- Contract/profile/host declaration asset이 누락되면 package check는 fail한다.

### Contract와 Capability

Universal contract는 versioned declarative manifest로 분리한다.
Machine-readable canonical form은 JSON Schema로 검증 가능한 JSON이다.
사람이 작성하는 contract pack은 YAML도 허용하되, build 단계에서 canonical JSON으로 normalize한다.
Contract, profile, host declaration 검증은 `ajv`로 수행한다.
PR 1은 canonical policy source를 안정화하는 단계이므로 검증된 JSON Schema validator를 사용한다.
Node 기본 기능만으로 검증기를 직접 구현하면 schema보다 validator code가 더 큰 위험이 된다.
Machine-readable canonical contract, profile, host declaration schema는 기본적으로
`additionalProperties: false`를 사용한다. Unknown field는 warning이 아니라 validation error다.
확장이 필요한 위치만 `metadata`, `x-*`, `extensions` 같은 명시 필드로 열어 둔다.
Typo나 조용한 drift가 policy로 흘러들어오는 것을 막기 위한 정책이다.

Contract validation은 두 단계로 나눈다.

1. JSON Schema validation: field shape, enum, required field, `additionalProperties`를 검증한다.
2. Semantic validation: graph cycle, reference integrity, profile threshold consistency, capability matching, release support 상태를 검증한다.

PR 1의 `tests/contract-assets.test.ts`는 두 단계를 모두 실행한다.

모든 manifest에는 다음 version 필드를 둔다.

- `schemaVersion`: 이 JSON 문서를 검증할 schema version
- `contractVersion`: contract semantics version
- `minimumPavedaVersion`: 이 manifest를 해석할 수 있는 최소 Paveda version

Version 정책:

- Unknown major version: early block
- Known major + newer minor/patch: migration 또는 compatibility table로 처리
- `minimumPavedaVersion` 미충족: early block
- 오래된 host projection이나 contract pack을 새 Paveda가 조용히 오해석하지 않음

권장 구조:

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
```

`universal-contract.v1.json` 최소 필드:

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

이 필드셋은 host-native 실행 방식을 보존하면서도 Paveda가 모든 host에서 강제할
universal contract를 schema로 검증하기 위한 최소 단위다.
Profile별 세부 threshold와 gate 조합은 profile manifest로 분리하되,
contract manifest는 어떤 policy surface가 존재해야 하는지를 고정한다.

`phaseGraph`는 DAG로 검증한다.
`nodes`와 `edges`는 가능한 phase 전이를 정의하고, `happyPath`는 기본 선형 경로를 제공한다.
`entryPhase`는 run 시작 phase, `terminalPhases`는 정상/차단/실패 종료 phase를 정의한다.
`repairEdges`는 검증 실패 이후 repair loop로 되돌아갈 수 있는 허용 경로만 명시한다.
PR 1에서는 JSON Schema가 구조를 검증하고, 테스트가 cycle detection과 `happyPath` 연결성을 검증한다.

Profile manifest 최소 필드:

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

`releaseSupport`는 profile 실행 가능 여부를 schema로 표현한다.
MVP의 `release` profile은 존재하지만 실행은 `not-supported-in-mvp`로 early block하므로,
이 상태를 profile manifest에서 명시해야 한다.

확장성은 plugin platform보다 먼저 `capability adapter + contract pack` 구조로 간다.

- `host adapter`: Claude Code, Codex, Pi, Hermes 등 host integration
- `capability adapter`: goal, workflow, loop, hook, MCP, memory, test, browser, review
- `contract pack`: default, strict engineering, release, security-sensitive 등 정책 bundle
- `project pack`: 특정 repo/domain용 추가 rule/check/hook
- `evidence provider`: test runner, browser runner, semantic reviewer, security scanner, coverage parser

MVP capability id:

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

Phase node의 `requiredCapabilities`, evidence의 `providerCapability`,
host declaration의 `capabilities`는 모두 이 capability id를 참조한다.
Unknown capability id는 validation error다.
새 capability는 contract version 또는 명시 extension policy로 추가한다.

Contract capability definition 필드:

- `id`
- `category`
- `description`
- `requiredBy`
- `evidenceKinds`
- `missingBehavior`
- `fallbackPolicy`

Host capability entry 필드:

- `id`
- `support`
- `confidence`
- `source`
- `nativePrimitive`
- `limitations`
- `requiresSetup`
- `setupSprintAllowed`

Contract definition은 "무엇이 필요한가"를 정의한다.
Host capability entry는 "이 host가 어떻게 제공하는가"를 선언한다.
`support`는 supported/partial/unsupported/unknown 같은 상태를 표현하고,
`confidence`는 manifest 또는 runtime discovery 신뢰도를 기록한다.
Required capability가 missing이고 `fallbackPolicy`가 안전한 setup을 허용하면
사용자 승인 후 setup sprint로 넘어갈 수 있다.

Required capability가 없으면 자동 downgrade하지 않고 block한다.
안전한 fallback이 있으면 사용자 승인 후 setup sprint로 추가한다.

Host policy declaration은 패키지 기본 선언과 project override로 나눈다.

```text
assets/harness/hosts/
  claude-code.json
  codex.json
  pi.json
  hermes.json

.paveda/hosts/
  claude-code.json
  codex.json
```

Host declaration 최소 필드:

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

`supportLevel`은 `deep`, `shallow`, `experimental`, `unsupported` 같은 값으로 host별 구현 깊이를 드러낸다.
Claude Code와 Codex deep support, Pi와 Hermes shallow support를 같은 schema에서 비교하기 위한 필드다.
`lifecycleCapture`는 `hook`, `native`, `wrapper`, `manual` capture mode를 표현한다.

우선순위:

1. package host declaration
2. project host override
3. runtime discovery result
4. user-approved override

Runtime discovery 결과는 run 시작 시 capability snapshot으로 ledger에 고정한다.
실행 중 host/tool 버전이나 capability가 바뀌어도 해당 run은 snapshot 기준으로 평가한다.

정책:

- `paveda do`/`paveda run` 시작 시 discovery 실행
- package declaration + project override + runtime discovery를 merge
- merged capability snapshot을 `capabilities` 또는 `run_capabilities`에 저장
- run 중 capability drift 감지 시 `capability_drift` event 기록
- critical drift면 block 또는 사용자 판단

Claude Code adapter v2:

- Claude workflow와 loop를 Paveda가 대체하지 않는다.
- Hook이 제공하는 lifecycle event를 우선 capture한다.
- Hook으로 부족한 phase/evidence는 generated instruction과 skill output contract로 보강한다.
- Claude tool call, subagent/task usage, workflow completion은 `host_events`에 저장한다.
- Phase entry/exit와 evidence summary는 `phase_events`와 `evidence`에 normalize한다.
- Generated `CLAUDE.md`/skills는 contract obligations를 주입하지만 native workflow를 다시 구현하지 않는다.

Codex adapter v2:

- Codex goal title은 `runs.objective`로 import한다.
- Codex success criteria는 `runs.acceptance_criteria`로 import한다.
- Codex plan/progress/status는 `phase_events`와 `host_events`에 저장한다.
- Paveda score는 Codex native status와 혼합하지 않고 `scores`에 별도 저장한다.
- Codex goal 철학과 status lifecycle은 host-native state로 보존한다.
- Conflict는 contract compiler가 merge/override 선택지로 표시한다.

### Conformance

`paveda conformance`를 도입한다.
`doctor`가 설치/readiness 점검이라면, `conformance`는 host/project가 universal contract를 실제로 지킬 수 있는지 fixture로 증명한다.

검증 항목:

- phase event를 ledger에 남길 수 있는가
- required capability matrix를 만족하는가
- unit/e2e gate가 없는 code-changing task를 block하는가
- docs-only task를 `not-applicable` evidence로 통과시키는가
- host-native workflow를 덮어쓰지 않고 호출/참조하는가
- score threshold 미달 시 repair/block이 재현되는가
- evidence audit이 evidence 없는 pass 주장을 거부하는가
- interrupted run resume이 가능한가
- generated projection drift를 감지하는가

Conformance fixture format:

```json
{
  "id": "strict-code-change-requires-unit-e2e",
  "host": "codex",
  "profile": "strict",
  "task": {
    "type": "code",
    "objective": "Change user-visible behavior"
  },
  "setup": {
    "projectFixture": "fixtures/code-change",
    "projectionState": "clean"
  },
  "expected": {
    "result": "block",
    "events": ["run.started", "phase.started", "policy.blocked"],
    "evidence": ["unit_test", "e2e_test"],
    "artifacts": []
  },
  "assertions": [
    "missing unit evidence blocks strict run",
    "missing e2e evidence blocks user-visible change"
  ]
}
```

Fixture 필드:

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

### Self-Learning

Paveda는 operating memory를 넘어 self-learning을 포함한다.
단, 학습은 auditable해야 하며 ledger/evidence에 근거해야 한다.

권한 모델:

1. `observed`
2. `candidate`
3. `validated`
4. `promoted`
5. `retired`

기본은 proposal-first다.
검증된 pattern만 auto-apply로 승격한다.
Score threshold나 required gate를 낮추는 학습은 영구 금지한다.

Promotion threshold:

- `candidate`가 되려면 최소 1개 run evidence가 필요하다.
- `validated`가 되려면 최소 3개 성공 run 또는 동등한 수동 검증 evidence가 필요하다.
- `promoted`가 되려면 confidence `>= 0.9`, evidence audit 통과, 사용자 승인이 필요하다.
- 실패 run과 충돌하는 pattern은 자동 promotion할 수 없다.
- Promotion은 project scope를 기본값으로 한다.
- User/shared scope promotion은 redaction, review, conformance를 추가로 요구한다.
- Learning은 gate, score threshold, required evidence를 완화할 수 없다.

Learning scope:

- `run`
- `project`
- `user`
- `shared pack`

기본 학습은 project scope에 머문다.
더 넓은 scope로 승격하려면 승인, redaction, evidence audit, conformance를 통과해야 한다.

Storage:

- Runtime/cache: `.paveda/learning/cache/`
- Commit 가능한 promoted knowledge:
  - `.paveda/learning/patterns.json`
  - `.paveda/learning/host-quirks.json`
  - `.paveda/learning/test-strategies.json`
  - `.paveda/learning/risk-rules.json`

### Override

Override는 허용하지만, 해제가 아니라 감사 가능한 예외로 기록한다.
Release profile에서는 일부 override를 금지한다.

허용 가능:

- 특정 e2e gate를 `not-applicable`로 marking, 근거 필수
- semantic reviewer unavailable 시 대체 reviewer 지정
- one-time risk acceptance
- host-specific workflow mapping override
- generated projection drift override

금지:

- code-changing task에서 unit gate 완전 제거
- code-changing task에서 모든 e2e 판단을 영구 제거
- score threshold 완화
- evidence 없이 pass 처리
- release profile에서 security-critical risk 무시

Override 기록:

- who/when/why
- affected run/profile/contract
- scope: one-run/project/profile
- expiry
- compensating control
- evidence reference

### CLI 정리

기존 CLI 명령도 정리한다. v1 호환 유지가 아니라 고도화 리팩토링 기준으로 사용자-facing CLI를 다시 설계한다.

권장 CLI:

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

paveda contract validate
paveda contract explain [--profile strict]
paveda capabilities --host <host>
```

정리/제거 후보:

- `events`: raw debug 전용 또는 hidden
- `router-trace`: `status/evidence`에 흡수
- `instincts`: `learning`으로 통합
- `runtime-smoke`: `conformance smoke`로 흡수
- `adoption-report`: `doctor` 또는 `conformance`와 통합 가능

## MVP 범위

MVP host 범위:

- Claude Code: deep support
- Codex: deep support
- Pi: shallow support
- Hermes: shallow support

Claude Code deep support mapping:

- Claude workflow start → `run.started` 또는 `phase.started`
- Claude loop iteration → `attempt_id` 또는 `phase_events`
- Claude tool calls → `host_events`
- Claude subagent/task usage → `host_events` + `phases.host_mapping`
- Claude workflow completion → `phase.completed` 또는 `run.completed`
- Claude native assertions/checks → `evidence`로 import
- Paveda generated `CLAUDE.md`/skills는 workflow를 대체하지 않고 contract obligations를 주입

Claude native loop가 있으면 Paveda `/do`가 별도 loop를 강제하지 않는다.
Paveda는 required gate와 ledger/evidence를 요구한다.
Hook이 capture하지 못하는 phase는 skill output contract로 보강한다.
Conflict는 host policy declaration에서 감지한다.

Codex deep support mapping:

- Codex goal title → `run.objective`
- Codex goal details → `run.context`
- Codex success criteria → `run.acceptance_criteria`
- Codex plan/progress → `phase_events`
- Codex native status → `host_events.normalized_status`
- Paveda score → 별도 `scores`. Codex 점수와 혼합하지 않고 reference로 연결
- Conflict 발생 시 contract compiler가 merge/override 선택지 제시

Paveda는 Codex native goal 철학을 덮어쓰지 않고, Codex goal을 strict contract로 검증하는 역할을 한다.

MVP 구현 순서:

1. Contract manifest
2. Profile manifests
3. Capability schema와 host capability declarations
4. Portable execution ledger schema
5. CLI 재설계
6. `/do`를 contract shell로 재작성
7. `/verify`를 Verification Ladder로 확장
8. Claude Code adapter 확장
9. Codex adapter/wrapper/conformance skeleton
10. `paveda conformance --host claude-code|codex`

PR 1 범위:

- `assets/harness/contracts/universal-contract.v1.json`
- `assets/harness/contracts/profiles/{fast,standard,strict,release}.json`
- `assets/harness/contracts/schemas/contract.schema.json`
- `assets/harness/contracts/schemas/capabilities.schema.json`
- `assets/harness/hosts/{claude-code,codex,pi,hermes}.json`
- `ajv` dev/runtime dependency 추가
- `package-check.mjs`에서 `.paveda` forbidden pattern 제거
- contract/profile/host/schema asset inclusion check 추가
- schema validation tests
- unknown field rejection tests
- manifest version field validation tests
- profile manifest required field validation tests
- host declaration required field validation tests
- phase graph cycle detection and happy path connectivity tests
- phase node required field validation tests
- phase edge type and repair maxAttempts validation tests
- required evidence schema and not-applicable policy validation tests
- evidence kind enum validation tests
- evidence resultPolicy strict acceptance validation tests
- capability id reference validation tests
- capability definition and host capability entry validation tests
- score metric definition and profile threshold validation tests
- score calculation kind enum validation tests
- profile required gate validation tests
- release profile `not_supported_in_mvp` validation tests
- package asset inclusion tests
- docs update

PR 1 테스트 구조:

- `tests/contract-assets.test.ts`에서 contract/profile/host declaration JSON을 모두 로드한다.
- 같은 테스트 파일에서 `ajv` schema validation을 수행한다.
- Unknown field rejection fixture를 포함한다.
- Manifest version field validation을 포함한다.
- Profile manifest required field validation을 포함한다.
- Phase graph cycle detection과 happy path connectivity validation을 포함한다.
- Phase node required field validation을 포함한다.
- Phase edge type validation과 repair `maxAttempts` validation을 포함한다.
- Required evidence schema validation과 `notApplicableAllowed` policy validation을 포함한다.
- Evidence kind enum validation을 포함한다.
- Evidence `resultPolicy` strict acceptance validation을 포함한다.
- Capability id reference validation을 포함한다.
- Capability definition과 host capability entry validation을 포함한다.
- Score metric definition과 profile threshold validation을 포함한다.
- Score calculation kind enum validation을 포함한다.
- Profile required gate validation을 포함한다.
- Release profile `not_supported_in_mvp` validation을 포함한다.
- Package asset inclusion을 검증한다.
- Host policy semantics가 독립적으로 커지면 후속 PR에서 `tests/host-policy.test.ts`로 분리한다.

PR 1에서 제외:

- EventStore/ledger schema rewrite
- CLI rewrite
- `/do` rewrite
- adapter implementation
- conformance runner

PR 1 구현 상태:

- `assets/harness/contracts/universal-contract.v1.json` 추가
- `assets/harness/contracts/profiles/{fast,standard,strict,release}.json` 추가
- `assets/harness/contracts/schemas/{contract.schema,capabilities.schema}.json` 추가
- `assets/harness/hosts/{claude-code,codex,pi,hermes}.json` 추가
- `ajv`를 runtime dependency로 추가
- machine manifest는 unknown field를 기본 차단하고 `metadata`, `extensions`, `x-*`만 확장 지점으로 허용
- `package-check.mjs`에서 `.paveda/` forbidden content 규칙 제거
- `package-check.mjs`에서 contract/profile/schema/host asset tarball 포함 여부 검증
- `tests/contract-assets.test.ts`에서 AJV shape validation과 DAG/reference/gate/score/release semantic validation 수행
- 현 e2e gate는 `pnpm package:check`다. Tarball 생성 후 packaged CLI smoke를 실행하므로 PR 1에서는 package-level E2E로 취급한다.
- ledger rewrite, CLI rewrite, `/do` rewrite, adapter implementation, conformance runner는 아직 제외 상태다.

PR 2 구현 상태:

- `CURRENT_SCHEMA_VERSION = 2`
- 기존 `events`, `sessions`, `router_decisions`, `instincts` table은 hook/runtime 호환을 위해 유지
- 신규 ledger table 추가:
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
- 기본 project store path를 `.paveda/ledger/paveda.db`로 변경
- 기본 user store path를 `~/.paveda/ledger/paveda.db`로 변경
- `run_id`는 UUID v7로 자동 생성하고 non-v7 id는 거부
- raw artifact는 `.paveda/artifacts/<run_id>/` 아래에 기록
- ledger artifact row는 relative path, sha256, byte length, kind, redaction status, metadata만 저장
- evidence result는 `pass`, `fail`, `block`, `not_applicable`, `inconclusive`만 허용하고 `skip`은 거부
- audited override decision은 `decisions`에 rationale, override flag, expiry와 함께 기록
- self-learning pattern은 `learning_patterns`에 state/confidence/evidence reference로 기록
- runtime smoke와 package smoke는 `.paveda/ledger/paveda.db`를 기준으로 갱신
- PR 4 전까지 public CLI command naming은 기존 형태를 유지

PR 3 구현 상태:

- `paveda init --host <host> --write`가 `.paveda/manifest.json`, `.paveda/contract.json`, `.paveda/capabilities.json`, `.paveda/test-policy.json`, `.paveda/profiles/strict.json`, `.paveda/hosts/<host>.json`, `.paveda/.gitignore`, `.paveda/projections/index.json`을 생성한다.
- `.paveda/.gitignore`는 runtime state를 commit 대상에서 제외한다: `ledger/`, `artifacts/`, `state/`, `learning/cache/`, `tmp/`.
- projection index는 host, projection path, projection kind, source manifest hash, source asset hashes, content hash, snapshot path, generator version, drift policy, manual override id를 기록한다.
- projection snapshot은 `.paveda/projections/snapshots/<host>/`에 저장한다. `paveda projection diff`는 이 snapshot과 현재 host projection을 비교한다.
- `paveda projection status --host <host>`는 missing/drifted projection이 있으면 non-zero exit로 block한다.
- `paveda projection diff --host <host>`는 drift와 recovery command를 보여준다.
- `paveda projection regenerate --host <host> --write`는 packaged Paveda asset에서 host projection을 재생성하고 index를 갱신한다.
- `paveda projection import --host <host> --path <file> --write`는 명시적으로 선택된 projection 변경을 `.paveda/hosts/<host>/imports/` 아래에 보관하고 expected hash를 갱신한다.
- `paveda projection approve-override --host <host> --path <file> --reason <text> --expires-at <ISO> --write`는 projection index와 PR 2 ledger `decisions` table에 감사 가능한 예외를 남긴다.
- `release` profile로 projection execution을 요청하면 `not_supported_in_mvp`로 early block한다. `strict`로 조용히 downgrade하지 않는다.
- package-level E2E인 `pnpm package:check`는 projection clean status, drift block, diff, import resolution, release early block을 packaged CLI smoke로 검증한다.
- YAML authoring/normalization, full contract compiler, host-specific generated header/sidecar 세부 구현은 이후 phase로 남긴다.

PR 4 구현 상태:

- `paveda contract validate`는 `.paveda` contract source를 검증한다. AJV로 contract, profile, host declaration, capability entry, 필수 policy file을 확인한다.
- `paveda contract explain --profile <profile>`은 phase happy path, evidence result, required gate, score threshold, verification ladder, release support를 반환한다.
- `paveda capabilities --host <host>`는 project override를 먼저 읽고, 없으면 package host declaration을 읽는다.
- `paveda do`는 UUID v7 ledger run을 만들고, capability snapshot, intake phase event, host handoff event를 기록한다. Codex는 native `goal` handoff를 기록하고, 아직 deep start 지원이 없는 host만 `pending_adapter`로 남긴다.
- `paveda run <host> -- <native command>`는 native command를 wrapper로 실행한다. command start/end host event, stdout/stderr artifact, command evidence를 기록하고 exit code에 따라 run을 completed/failed로 닫는다.
- `paveda status --run <id>`는 run, phase events, evidence, artifacts, scores, decisions, policy violations를 반환한다.
- `paveda evidence --run <id>`는 evidence를 조회한다. `paveda evidence add`는 universal contract evidence result enum으로 evidence를 기록한다.
- `paveda verify --run <id>`는 profile required gate와 recorded evidence를 비교한다. `--write`를 주면 verification score와 blocking policy violation을 ledger에 기록한다.
- strict `e2e-gate`가 `code` task type을 포함하도록 수정했다. 따라서 code-changing strict run은 unit/e2e evidence가 모두 필요하다.
- `release` profile로 `do`, `run`, `verify` 실행을 요청하면 `not_supported_in_mvp`로 early block한다. `strict`로 조용히 downgrade하지 않는다.
- `do`와 `run`은 projection drift가 있으면 run 시작 전에 block한다.
- package-level E2E인 `pnpm package:check`는 contract validate/explain, capabilities, do, missing-evidence verify block, evidence add, verify pass, status/evidence list, native run wrapper, release early block을 packaged CLI smoke로 검증한다.
- full host adapter `startRun()`, conformance runner, advanced evidence provider는 PR 5 이후로 남긴다.

PR 5 구현 상태:

- `/do`를 host-native contract shell로 재작성했다. Paveda가 별도 PDCA 실행기를 강제하지 않고, host의 goal/workflow/loop를 사용하면서 `.paveda` contract, projection drift, ledger run, evidence, score, handoff 의무만 강제한다.
- `/verify`를 profile manifest 기반 Verification Ladder로 재작성했다. 단순 lint/test/build 체크리스트가 아니라 required gate, evidence result, not-applicable policy, score threshold를 판정한다.
- `verifyRun`은 `gates[]`, `ladder[]`, `scoreSummary`를 반환한다. `--write`에서는 `verification_score`와 blocking policy violation을 ledger에 기록한다.
- `verification_score`는 `(pass gate + valid not_applicable gate) / required gate`로 계산한다. strict profile은 threshold `1`을 요구한다.
- code-changing task(`code`, `ui`, `api`, `data`, `infra`, `test`, `mixed`)는 unit/e2e gate에서 `not_applicable`을 사용할 수 없다.
- docs/metadata task는 unit/e2e gate를 `not_applicable`로 통과할 수 있지만, rationale, `metadata.classifierReason`, `metadata.userApproval` 또는 `metadata.approvedBy`가 필요하다.
- strict/release profile의 unit/e2e gate에 docs/metadata를 포함했다. 따라서 테스트 비대상 변경도 조용히 통과하지 않고 not-applicable 근거를 남겨야 한다.
- package-level E2E는 code task의 unit/e2e `not_applicable` block과 docs task의 audited `not_applicable` pass를 검증한다.

PR 6 구현 상태:

- Claude Code hook payload를 `hostLifecycle`로 normalize한다. 포함 필드는 host, run id, phase id, event type, normalized status, compact payload다.
- hook payload에 `paveda_run_id`, `run_id`, 또는 `PAVEDA_RUN_ID`가 있으면 run ledger에 `host_events`와 `phase_events`를 기록한다.
- `PostToolUse` Bash hook은 command evidence를 기록한다. command, exit code, pass/fail/inconclusive result, Claude tool metadata를 포함한다.
- `status --run`은 `hostEvents[]`를 반환한다. Claude lifecycle capture를 run summary에서 확인할 수 있다.
- Claude Code host declaration에 `claude-hook-lifecycle-capture`, `claude-bash-command-evidence` fixture를 추가했다.
- package-level E2E는 packaged CLI의 `hook claude-code`에 run-aware PostToolUse payload를 입력하고, `status --run`에서 host event와 command evidence가 노출되는지 검증한다.
- Claude Code workflow/loop 실행은 계속 host-native로 둔다. Paveda는 실행을 대체하지 않고 lifecycle capture와 normalization만 수행한다.

PR 7 구현 상태:

- Codex 전용 adapter module을 추가해 native goal status를 `active`, `completed`, `blocked`, `failed`로 정규화한다.
- `paveda do --host codex`는 `pending_adapter`가 아니라 `native_handoff`를 반환하고, `primitive = goal`을 명시한다.
- Codex handoff는 `codex.goal.created`를 `host_events`에 기록하고, 같은 handoff를 `phase_events`에도 기록한다.
- Codex goal payload에는 Paveda `run.objective`, `run.acceptance_criteria`, profile, task type, cwd, native status, normalized status가 포함된다.
- Paveda score는 Codex native status와 섞지 않고 `scores`에 별도로 남긴다.
- Codex host declaration에 `codex-goal-lifecycle-handoff`, `codex-native-goal-status-mapping` conformance fixture를 추가했다.
- package-level E2E는 packaged CLI에서 Codex goal handoff를 만들고 `status --run`으로 host/phase event 노출을 검증한다.

MVP에서 구현:

- `fast`, `standard`, `strict` 실제 동작
- `release`는 schema와 conformance placeholder. 직접 실행 요청 시 `not-supported-in-mvp`로 early block
- `.paveda` 중심 source-of-truth 구조
- Generated projection drift detection
- Unit/e2e required gate
- Strict score loop
- Portable execution ledger
- Basic auditable self-learning lifecycle

PR 8 구현 상태:

- `paveda learning list|propose|explain|promote|retire`를 추가했다.
- Learning proposal은 `learning_patterns` ledger table에 기록하고, `promoted` 또는 `retired` 상태로 직접 생성할 수 없다.
- `candidate`와 `validated` learning은 run evidence 연결을 요구한다.
- Promotion은 MVP에서 project scope만 허용한다. `validated` 상태, confidence `>= 0.9`, evidence id, `successfulRuns >= 3` 또는 `manualValidation = true`, evidence audit pass, 사용자 승인 값을 모두 요구한다.
- Learning policy는 unit/e2e gate, score threshold, required evidence, release restriction을 skip/bypass/disable/waive/relax하려는 pattern을 거부한다.
- `paveda learning promote --write`는 `.paveda/learning/patterns.json`에 promoted project knowledge를 기록한다.
- `paveda learning retire --write`는 promoted ledger row만 기준으로 `patterns.json`을 다시 써서 retired pattern이 active knowledge로 남지 않게 한다.
- package-level E2E는 packaged CLI에서 propose, promote, explain, knowledge file write, retire, active knowledge removal을 검증한다.

PR 9 구현 상태:

- `paveda conformance --host claude-code|codex|pi|hermes`를 추가했다.
- Conformance는 기본적으로 `/tmp` 아래 isolated fixture project에서 실행하므로 호출자의 repository를 조용히 변경하지 않는다.
- Host declaration의 `conformanceFixtures[]`가 runner 입력이다. 모르는 fixture id는 무시하지 않고 fail 처리한다.
- 공통 fixture는 strict code-changing unit/e2e block, docs-only audited `not_applicable`, projection drift block, release `not_supported_in_mvp`를 검증한다.
- Claude Code fixture는 lifecycle hook capture와 Bash command evidence import를 검증한다.
- Codex fixture는 native goal handoff와 native status normalization을 검증한다.
- package-level E2E는 packaged CLI에서 Codex와 Claude Code conformance를 실행한다.

## Phase 2 이후 항목

MVP 이후 진행할 항목:

- Pi/Hermes deep lifecycle adapter
- Release profile 완성
- YAML authoring 지원과 canonical JSON normalization pipeline
- Advanced evidence providers
- Broader self-learning promotion automation
- Shared pack packaging과 distribution
- CI/JUnit-like output
- Rich host-specific progress UI
- Advanced risk/security verification ladder
- Cross-project/user-level learning promotion

## Release와 Versioning

이 리팩토링은 breaking refactor다.
기존 v1 호환이나 자동 migration을 목표로 하지 않는다.

Release 전략:

- package major 또는 pre-major line으로 배포한다.
- 기존 `.harness` 기반 설치는 자동 변환하지 않는다.
- 사용자는 `paveda init --host <host>` 또는 명시 migration command로 `.paveda` source-of-truth를 만든다.
- 기존 host-native files는 generated projection drift로 감지한다.
- Paveda는 조용히 덮어쓰지 않고 import/regenerate/approve-override 선택지를 제공한다.
- Contract version과 package version은 분리한다. Package major가 바뀌어도 `universal-contract.v1`은 compatibility table로 유지할 수 있다.

## 확정 상태

인터뷰 질문은 종료한다.
이후 결정은 추천안 기준으로 진행하고, 구현 중 새 제약이 발견되면 문서의 decision log와 design spec을 업데이트한다.
