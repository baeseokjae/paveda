# Paveda Phase 2 Implementation Plan

이 문서는 Paveda MVP 이후 남은 후속 작업을 실제 PR로 나눠 구현하기 위한 계획이다.
기준 문서는 `docs/paveda-next-architecture-notes.md`와
`docs/paveda-next-design-spec.md`다.

## 목표

Phase 2의 목표는 MVP에서 얕게 남긴 host 지원, release gate, evidence 자동화,
learning 확장, 배포 가능한 pack 구조를 실제 운영 가능한 수준으로 끌어올리는 것이다.
Paveda는 여전히 host-native workflow를 대체하지 않는다. 각 host의 실행 철학은
보존하고, Paveda는 contract, ledger, verification, learning, conformance를 공통
계층으로 강제한다.

## 현재 기준선

MVP에서 완료된 범위:

- `fast`, `standard`, `strict` profile은 실행 가능하다.
- `release` profile은 Phase 2 PR 2에서 실행 가능 상태로 승격했다. Verification은 release
  signoff, full conformance, immutable artifact retention을 포함한 release gate를 요구한다.
- Claude Code와 Codex는 deep support 상태다.
- Pi와 Hermes는 Phase 2 PR 1에서 deep lifecycle support로 승격했다. Native
  `goal`, `workflow`, `loop` primitive는 아직 unsupported다.
- `.paveda` source-of-truth, projection drift block, ledger, evidence, learning lifecycle,
  conformance runner가 있다.
- `pnpm release:check`는 typecheck, test, lint, build, performance, package smoke를
  모두 실행한다.

Phase 2에서 유지할 불변 조건:

- Required gate, score threshold, release restriction은 learning이나 override로 낮출 수 없다.
- Projection drift는 기본 block이다. 자동 수정은 `regenerate`, `import`,
  `approve-override` 같은 명시 명령에서만 한다.
- `release`는 조용히 `strict`로 downgrade하지 않는다. Evidence가 부족하면 release gate에서
  block한다.
- Raw artifact는 ledger DB에 직접 넣지 않고 파일 시스템에 저장하며, ledger에는 path/hash
  reference를 남긴다.
- Host adapter는 discovery, install, normalization, capture, doctor/readiness를 맡는다.
  모델 실행이나 host-native planner 대체는 하지 않는다.

## 구현 순서

아래 순서는 의존성을 기준으로 정했다. 앞 PR의 contract와 ledger 표면이 뒤 PR의
검증 대상이 된다.

| 순서 | 작업 | 주요 산출물 |
| --- | --- | --- |
| 1 | Pi/Hermes deep lifecycle adapter | 완료: Pi/Hermes host event, phase event, command evidence, conformance fixture |
| 2 | Release profile activation | 완료: release gate, immutable artifact metadata policy, release conformance |
| 3 | YAML authoring and contract compiler | 완료: YAML/JSON source compile, canonical JSON output, compiler diagnostics |
| 4 | Advanced evidence providers | 완료: evidence provider policy, collect CLI, artifact/redaction capture |
| 5 | CI/JUnit-like output | 완료: normalized JSON report, JUnit-like XML, verify/conformance CLI output |
| 6 | Learning promotion expansion | 완료: user/shared promotion policy, shared export/import, promoted audit trail |
| 7 | Shared pack packaging and distribution | 완료: deterministic .tgz pack build/inspect/verify/install |
| 8 | Rich host progress surface | 완료: run progress schema, status markdown, progress/handoff CLI |
| 9 | Risk/security ladder hardening | 완료: risk surface classifier, conditional release risk/security gates |
| 10 | Ledger search and artifact retention | 완료: FTS5 ledger search, artifact list/compact, release retention guard |

## PR 1. Pi/Hermes Deep Lifecycle Adapter

### 구현 전 문제

Pi와 Hermes는 `src/adapters/pi/index.ts`, `src/adapters/hermes/index.ts`에서 hook payload를
Paveda lifecycle event로 변환할 수 있었다. 하지만 host declaration은
`supportLevel: "shallow"`이고, `paveda do --host pi|hermes`는
`pending_adapter` handoff만 기록한다. Conformance도 공통 fixture만 실행한다.

### 목표 상태

- Pi/Hermes host declaration을 schema가 허용하는 `deep` 수준으로 올린다.
- `paveda do --host pi|hermes`가 host-native handoff event를 기록한다.
- Pi/Hermes hook payload가 `hostLifecycle` payload를 포함해 `host_events`,
  `phase_events`, command evidence까지 남긴다.
- Conformance가 Pi/Hermes 전용 lifecycle fixture를 검증한다.

### 구현 작업

1. `src/adapters/pi/index.ts`
   - Pi native event를 `pi.session.started`, `pi.tool.completed`,
     `pi.session.completed` 같은 Paveda event type으로 정규화한다.
   - Bash/shell 결과에서 command evidence를 만들 수 있으면
     `hostLifecycle.evidence`를 생성한다.
   - `paveda_run_id`, `run_id`, `PAVEDA_RUN_ID`를 payload/env에서 읽어 run에 연결한다.

2. `src/adapters/hermes/index.ts`
   - Hermes native event를 `hermes.session.started`, `hermes.tool.completed`,
     `hermes.session.completed`로 정규화한다.
   - `transform_terminal_output`과 `post_tool_call`에서 command, exit code, output metadata를
     command evidence로 변환한다.
   - `pre_gateway_dispatch`, `pre_approval_request`, `post_approval_response`는
     phase event와 policy/audit metadata로 남긴다.

3. `src/execution/index.ts`
   - `recordHostNativeStart()`의 `pending_adapter` 분기를 host adapter별 handoff로 분리한다.
   - `StartHostNativeResult`에 Pi/Hermes primitive와 next action을 표현한다.
   - unsupported native start는 `pending_adapter`로 남기되, Pi/Hermes deep fixture가 필요한
     조건에서는 block한다.

4. `assets/harness/hosts/pi.json`, `assets/harness/hosts/hermes.json`
   - `supportLevel`, `capabilities`, `unsupportedCapabilities`, `lifecycleCapture`,
     `eventMappings`, `commandMappings`, `conformanceFixtures`를 갱신한다.
   - `hook.lifecycle`, `workflow.native` 또는 해당 host가 제공하는 실제 primitive만
     supported로 올린다.

5. `src/conformance/index.ts`
   - `pi-hook-lifecycle-capture`, `pi-command-evidence`,
     `hermes-hook-lifecycle-capture`, `hermes-command-evidence` fixture를 추가한다.
   - fixture는 isolated project에서 `startPavedaDo()`를 만든 뒤 hook adapter payload를
     dispatch하고, `summarizeRun()`으로 host event와 evidence를 확인한다.

### 테스트

- `tests/pi-adapter.test.ts`
- `tests/hermes-adapter.test.ts`
- `tests/conformance.test.ts`
- `tests/contract-flow.test.ts`
- `pnpm test -- tests/pi-adapter.test.ts tests/hermes-adapter.test.ts tests/conformance.test.ts`
- 최종 `pnpm release:check`

### 완료 기준

- `paveda conformance --host pi`가 Pi lifecycle/command evidence fixture를 통과한다.
- `paveda conformance --host hermes`가 Hermes lifecycle/command evidence fixture를 통과한다.
- Pi/Hermes host declaration에 더 이상 실제 지원되는 deep capability가
  `unsupportedCapabilities`에 남아 있지 않다.
- `paveda status --run <id>`에서 Pi/Hermes host events와 phase events가 보인다.

### 구현 상태

- 완료.
- Pi/Hermes hook payload는 `hostLifecycle` payload를 생성한다.
- Pi `tool_result`/`tool_execution_end`와 Hermes `post_tool_call`/
  `transform_terminal_output` 계열 hook은 Bash command evidence를 기록한다.
- `paveda do --host pi|hermes`는 `native_handoff`와 `primitive = hook_lifecycle`을 기록한다.
- Pi/Hermes host declarations는 `supportLevel = deep`, `hook.lifecycle` supported,
  `recordsPhaseEvents = true`로 갱신됐다.
- Conformance에 `pi-hook-lifecycle-capture`, `pi-command-evidence`,
  `hermes-hook-lifecycle-capture`, `hermes-command-evidence` fixture가 추가됐다.
- 검증: `pnpm typecheck`, `pnpm test -- tests/pi-adapter.test.ts tests/hermes-adapter.test.ts tests/conformance.test.ts tests/contract-assets.test.ts`

## PR 2. Release Profile Activation

### 문제

`assets/harness/contracts/profiles/release.json`은 strict보다 강한 gate를 선언하지만,
MVP에서는 `not_supported_in_mvp`로 실행을 막았다. Release profile을 실제로 실행하려면
불변 artifact, full conformance, release signoff, override 제한을 명확히 구현해야 한다.

### 목표 상태

- `release` profile이 실제 실행 가능하다.
- Release run은 모든 required gate가 direct pass evidence를 갖거나, release에서 허용한
  좁은 예외만 통과한다.
- Release artifact는 hash, retention, redaction status, signoff decision을 갖는다.
- Release conformance가 `not_supported_in_mvp`가 아니라 실제 release block/pass 경로를 검증한다.

### 구현 작업

1. Contract/profile asset
   - `releaseSupport.status`를 `supported`로 전환한다.
   - `release-signoff`, `full-conformance`, `immutable-artifact-retention`,
     `security-gate`, `adversarial-gate`를 required gate로 명시한다.
   - release에서는 `not_applicable` 허용 범위를 docs/metadata에도 더 좁게 둔다.

2. Runtime
   - `assertMvpExecutableProfile()` 또는 release block 지점을 제거하고
     release-specific policy check로 대체한다.
   - `verifyRun()`이 release gate를 평가할 때 direct evidence, artifact hash,
     redaction status, approval decision을 함께 확인하도록 확장한다.
   - `approve-override`는 release-forbidden gate에서 실패해야 한다.

3. Store/artifact
   - artifact row에 retention policy, immutable flag, redaction decision을 강제한다.
   - release run 완료 시 artifact hash manifest를 생성한다.

4. Conformance
   - 기존 `release-not-supported` fixture를 `release-missing-gates-blocks`,
     `release-full-evidence-passes`로 교체한다.
   - Release `approve-override` 금지는 projection flow test와 package smoke에서 검증한다.

### 구현 상태

완료.

- `releaseSupport.status`를 `supported`로 전환하고 `unimplementedGates`를 비웠다.
- Release required gate에 `adversarial-gate`, `security-gate`, `release-signoff`,
  `full-conformance`, `immutable-artifact-retention`을 추가했다.
- `assertMvpExecutableProfile()`을 `assertExecutableProfile(cwd, profile)`로 대체해 오래된
  project manifest가 release unsupported 상태일 때만 block한다.
- `verifyRun()`은 release 전용 gate에서 signoff metadata/decision, conformance metadata/host event,
  immutable release artifact metadata와 redaction status를 확인한다.
- `paveda run --profile release`가 stdout/stderr artifact에 release immutable retention metadata를
  기록한다.
- Projection은 release에서 `import`와 `regenerate`를 허용하고 `approve-override`만 block한다.
- Conformance fixture는 `release-missing-gates-blocks`와 `release-full-evidence-passes`로 교체했다.

장기 artifact retention/compaction, FTS 검색, release artifact 삭제 방지는 PR 10에서 store-level
정책으로 확장한다.

### 테스트

- `tests/contract-assets.test.ts`
- `tests/contract-flow.test.ts`
- `tests/conformance.test.ts`
- `tests/store.test.ts`
- `tests/projection.test.ts`
- `pnpm release:check`

### 완료 기준

- `paveda do --profile release`가 더 이상 MVP block으로 실패하지 않는다.
- release evidence가 부족하면 어떤 gate가 부족한지 `verify` 결과에 나온다.
- 모든 release gate evidence를 기록하면 `verify --profile release --write`가 pass한다.
- release-forbidden override는 ledger decision 없이 block된다.

## PR 3. YAML Authoring And Contract Compiler

### 문제

현재 machine-authoritative format은 JSON이다. 사용자가 작성하는 contract pack은 YAML도 허용하기로
했지만, canonical JSON으로 normalize하는 compiler가 없다. 또한 full contract compiler와
host-specific generated header/sidecar 세부 구현이 남아 있다.

### 목표 상태

- 사용자는 YAML contract/profile/host declaration을 작성할 수 있다.
- `paveda contract compile`이 YAML과 JSON 입력을 canonical JSON으로 normalize한다.
- Canonical output은 stable key order, schema validation, semantic validation,
  source hash를 갖는다.
- Projection header/sidecar는 compiler metadata와 연결된다.

### 구현 작업

1. Dependency
   - YAML parser를 추가한다. 후보는 `yaml` package다.
   - 임의 DSL이나 expression evaluator는 도입하지 않는다.

2. Source layout
   - `.paveda/source/contract.yaml`
   - `.paveda/source/profiles/*.yaml`
   - `.paveda/source/hosts/*.yaml`
   - compiled output은 현재 `.paveda/contract.json`, `.paveda/profiles/*.json`,
     `.paveda/hosts/*.json`로 둔다.

3. Compiler
   - `src/contract/compiler.ts`를 추가한다.
   - parse, normalize, schema validate, semantic validate, emit 단계를 분리한다.
   - unknown fields는 현재 JSON 정책과 동일하게 금지한다.
   - compiler diagnostic은 path, code, severity, message를 갖는다.

4. CLI
   - `paveda contract compile --cwd <path> [--write]`
   - `paveda contract validate --source-only`는 source YAML만 검증하고 emit하지 않는다.
   - `paveda contract diff-source`는 source와 canonical output 차이를 보여준다.

5. Projection
   - projection index에 compiler source hash와 compiled hash를 기록한다.
   - parser-sensitive file은 sidecar metadata로 관리한다.

### 구현 상태

완료.

- `yaml` parser dependency를 추가했다.
- `.paveda/source/contract.yaml`, `.paveda/source/profiles/*.yaml`,
  `.paveda/source/hosts/*.yaml` 또는 JSON source를 읽는 `src/contract/compiler.ts`를 추가했다.
- `paveda contract compile --cwd <path> [--write]`가 source를 stable key order canonical JSON으로
  normalize하고 기존 `.paveda/contract.json`, `.paveda/profiles/*.json`,
  `.paveda/hosts/*.json` 위치에 emit한다.
- `paveda contract validate --source-only`는 emit 없이 source parse/schema/semantic validation을
  수행한다.
- `paveda contract diff-source`는 source와 canonical output의 clean/missing/drifted 상태를
  보고한다.
- Compiler diagnostic은 `path`, `code`, `severity`, `message`를 갖는다.
- Schema validation 외에 phase graph cycle, phase edge reference, capability reference semantic
  validation을 수행한다.
- Projection index에는 `compiler.sourceSha256`, `compiler.compiledSha256`, output별 source/compiled
  hash metadata를 기록한다.

Parser-sensitive generated header/sidecar의 세부 형식은 host projection polish 단계로 남긴다.

### 테스트

- `tests/contract-assets.test.ts`
- `tests/contract-flow.test.ts`
- `tests/projection.test.ts`
- package smoke에 `contract compile` 포함
- `pnpm release:check`

### 완료 기준

- YAML source에서 생성한 canonical JSON이 기존 JSON fixture와 semantic equivalent다.
- 동일 source를 두 번 compile하면 byte-identical output이 나온다.
- invalid YAML, unknown field, broken reference, graph cycle은 diagnostic과 non-zero exit로 실패한다.

## PR 4. Advanced Evidence Providers

### 문제

현재 evidence는 CLI `evidence add`, command wrapper, Claude Bash hook 등으로 기록된다.
Release와 advanced verification을 위해 coverage, semantic review, adversarial review,
risk review, security scan, browser/screenshot, trace evidence를 provider로 자동 수집해야 한다.

### 목표 상태

- Project policy가 evidence provider command를 선언한다.
- Paveda가 provider를 실행하고, result, command, exit code, artifact hash,
  redaction status를 ledger에 기록한다.
- Provider 실패는 `inconclusive` 또는 `block`으로 명확히 분류된다.

### 구현 작업

1. Policy schema
   - `.paveda/test-policy.json` 또는 새 `.paveda/evidence-policy.json`에 provider를 선언한다.
   - 필드: `id`, `kind`, `command`, `requiredForTaskTypes`, `timeoutMs`,
     `artifactGlobs`, `redactionRequired`, `passExitCodes`, `failureBehavior`.

2. Runtime
   - `src/evidence/providers.ts`를 추가한다.
   - command execution은 `runHostCommand()`와 중복되지 않게 공통 executor를 분리한다.
   - artifact glob capture, sha256, byte length, redaction status를 기록한다.

3. CLI
   - `paveda evidence collect --run <id> --kind <kind>`
   - `paveda verify --run <id> --collect`는 missing provider가 선언된 gate만 수집한다.

4. Redaction
   - secret-like content가 artifact에 있으면 `failed` redaction으로 기록하고 pass evidence로
     인정하지 않는다.

### 구현 상태

완료.

- `.paveda/evidence-policy.json` 또는 `.paveda/test-policy.json`의 `providers[]`를 읽는
  `src/evidence/providers.ts`를 추가했다.
- Provider field는 `id`, `kind`, `phaseId`, `command`, `requiredForTaskTypes`, `timeoutMs`,
  `artifactGlobs`, `redactionRequired`, `passExitCodes`, `failureBehavior`를 지원한다.
- `paveda evidence collect --run <id> [--kind <kind>] [--provider <id>]`가 provider command를
  실행하고 evidence/artifact ledger row를 기록한다.
- `paveda verify --run <id> --collect`는 검증 전에 provider collection을 수행한다.
- Artifact capture는 provider `artifactGlobs`를 `.paveda/artifacts/<run_id>/`로 복사하고
  source path/hash metadata를 기록한다.
- `redactionRequired` provider artifact에서 secret-like content가 발견되면 artifact
  `redactionStatus = failed`, evidence `result = fail`로 기록해 pass evidence로 인정하지 않는다.
- Provider command 실패는 `failureBehavior`에 따라 `fail`, `block`, `inconclusive`로 분류한다.

### 테스트

- `tests/evidence-providers.test.ts` 신규
- `tests/contract-flow.test.ts`
- `tests/store.test.ts`
- `scripts/package-check.mjs` packaged smoke
- `pnpm release:check`

### 완료 기준

- Provider command success가 pass evidence와 artifact row를 만든다.
- Provider command failure가 configured behavior에 따라 fail/block/inconclusive로 기록된다.
- Redaction 실패 artifact는 required evidence pass로 인정되지 않는다.

## PR 5. CI/JUnit-like Output

### 문제

현재 `verify`와 `conformance` 결과는 사람이 읽을 수 있지만, CI가 테스트 리포트처럼 소비하기에는
표준 출력 형식이 부족하다.

### 목표 상태

- `verify`, `conformance`, `release` 결과를 JSON과 JUnit-like XML로 출력한다.
- CI에서 실패 gate와 fixture를 test case로 볼 수 있다.
- GitHub Actions에서 artifact로 업로드하기 쉬운 파일 구조를 제공한다.

### 구현 작업

1. Result model
   - gate, ladder step, conformance fixture를 공통 report node로 normalize한다.
   - 필드: `suite`, `case`, `status`, `durationMs`, `message`, `details`, `artifactRefs`.

2. CLI
   - `--report-json <path>`
   - `--report-junit <path>`
   - `--report-dir <path>` convenience option

3. Package smoke
   - packaged CLI에서 report 파일을 생성하고 XML 최소 구조를 검증한다.

### 테스트

- `tests/reporters.test.ts` 신규
- `tests/conformance.test.ts`
- `tests/contract-flow.test.ts`
- `pnpm release:check`

### 완료 기준

- 실패한 gate는 JUnit testcase failure로 표현된다.
- block은 failure와 구분 가능한 property를 가진다.
- report file write는 repository 밖 임의 경로에도 path safety를 지킨다.

### 구현 상태

완료.

- `src/reporters/index.ts`가 verification gate, ladder step, conformance fixture를 공통
  report node로 정규화한다.
- `renderJUnit()`은 `pass`, `fail`, `block`, `not_applicable`, `not_required`를 JUnit-like
  testcase로 출력한다. `fail`과 `block`은 `<failure type="...">`로 구분된다.
- `paveda verify`와 `paveda conformance`는 `--report-json`, `--report-junit`,
  `--report-dir`를 지원한다.
- CLI JSON 결과에는 report file path가 `reports` 필드로 포함된다.
- Package smoke는 실패하는 `verify`에서도 JSON/XML report가 남는지 확인하고,
  `conformance` report 생성도 검증한다.

## PR 6. Learning Promotion Expansion

### 문제

MVP learning은 project scope만 promotion할 수 있다. Phase 2에서는 user/shared scope까지
확장하되, redaction, review, conformance를 통과한 pattern만 승격해야 한다.

### 목표 상태

- project, user, shared scope promotion 정책이 분리된다.
- user/shared promotion은 redaction, review, conformance evidence를 요구한다.
- shared pack으로 배포할 learning은 gate 완화 패턴을 포함할 수 없다.

### 구현 작업

1. Policy
   - `src/learning/index.ts`의 project-only MVP 제한을 scope별 policy로 분리한다.
   - user/shared scope 요구사항:
     - confidence `>= 0.95`
     - evidence audit pass
     - redaction pass
     - conformance pass
     - reviewer approval

2. Storage
   - user store `~/.paveda/learning/patterns.json`
   - shared pack 후보 `.paveda/learning/shared-candidates.json`
   - promoted pattern에는 source run, evidence hash, redaction hash, review decision을 남긴다.

3. CLI
   - `paveda learning promote --scope user`
   - `paveda learning export-shared --id <id> --out <path>`
   - `paveda learning import-shared --path <path> --reviewed-by <name>`

4. Conformance
   - shared learning이 gate/threshold/release restriction을 완화하려 하면 block한다.

### 테스트

- `tests/learning.test.ts`
- `tests/conformance.test.ts`
- `tests/store.test.ts`
- package smoke
- `pnpm release:check`

### 완료 기준

- project scope 기존 동작은 유지된다.
- user/shared promotion은 추가 evidence 없이는 실패한다.
- gate 완화 패턴은 모든 scope에서 거부된다.

### 구현 상태

완료.

- Project scope promotion은 기존 threshold `0.9`, validated state, linked evidence,
  validation support, evidence audit, approval 요구사항을 유지한다.
- User/shared scope promotion은 threshold `0.95`, evidence audit, redaction pass,
  conformance pass, reviewer approval을 요구한다.
- Promoted learning file entry에는 source run, evidence hash, redaction hash,
  conformance hash, review decision을 남긴다.
- User promoted knowledge는 `~/.paveda/learning/patterns.json`에 기록한다.
- Shared promoted 후보는 `.paveda/learning/shared-candidates.json`에 기록한다.
- `paveda learning export-shared --id <id> --out <path>`와
  `paveda learning import-shared --path <path> --reviewed-by <name>`를 추가했다.
- Shared import도 gate/threshold/release restriction 완화 패턴을 거부한다.

## PR 7. Shared Pack Packaging And Distribution

### 문제

Paveda는 contract pack과 capability adapter 구조를 지향하지만, 아직 공유 가능한 pack format과
distribution command가 없다.

### 목표 상태

- Contract, host declarations, promoted learning, risk rules, evidence providers를 pack으로 묶을 수 있다.
- Pack은 schema, version, compatibility, hashes, signature-ready metadata를 가진다.
- 사용자는 pack을 install/update/verify할 수 있다.

### 구현 작업

1. Pack format
   - `paveda-pack.json`
   - `contracts/`
   - `hosts/`
   - `learning/`
   - `evidence-providers/`
   - `risk-rules/`
   - `checksums.json`

2. CLI
   - `paveda pack build --cwd <path> --out <tgz>`
   - `paveda pack inspect <tgz>`
   - `paveda pack install <tgz> --cwd <path> [--write]`
   - `paveda pack verify <tgz>`

3. Policy
   - Unknown major version은 block한다.
   - Pack install은 projection drift와 같이 dry-run diff를 먼저 보여준다.
   - Shared learning은 import 시 review decision을 요구한다.

### 테스트

- `tests/pack.test.ts` 신규
- `tests/contract-assets.test.ts`
- `scripts/package-check.mjs`
- `pnpm release:check`

### 완료 기준

- Pack build 결과가 deterministic하다.
- Pack install dry-run은 변경 파일과 policy effect를 보여준다.
- 호환되지 않는 pack은 설치 전에 block된다.

### 구현 상태

완료.

- `src/pack/index.ts`가 dependency 없이 deterministic tar.gz pack을 생성하고 검증한다.
- Pack에는 `paveda-pack.json`, `checksums.json`, `contracts/`, `hosts/`, optional
  `learning/`, `evidence-providers/`, `risk-rules/` entries가 포함된다.
- `paveda pack build --cwd <path> --out <tgz>`를 추가했다.
- `paveda pack inspect <tgz>`와 `paveda pack verify <tgz>`가 manifest/checksum을 검증한다.
- `paveda pack install <tgz> --cwd <path>`는 dry-run diff를 반환하고, `--write`에서만
  대상 `.paveda` 파일을 갱신한다.
- Package smoke는 build, inspect, verify, install dry-run, install write를 packaged CLI로 검증한다.

## PR 8. Rich Host Progress Surface

### 문제

Ledger에는 phase와 host event가 쌓이지만, host별 진행 상황을 사용자가 빠르게 이해할 수 있는
상태 표면은 아직 제한적이다.

### 목표 상태

- `paveda status --run <id>`가 host별 progress summary를 제공한다.
- Host projection 또는 sidecar가 현재 phase, blocked gate, next command를 표시할 수 있다.
- UI가 없는 host에서도 JSON/markdown 출력으로 같은 정보를 볼 수 있다.

### 구현 작업

1. Summary model
   - phase status, latest host event, gate status, evidence gap, next command를 하나로 묶는다.

2. CLI
   - `paveda status --run <id> --format markdown|json`
   - `paveda progress --run <id> --watch`
   - `paveda handoff --run <id> --markdown`

3. Host projection
   - parser-sensitive host는 sidecar로 progress metadata를 둔다.
   - Markdown/instruction host는 generated status block을 넣을 수 있게 한다.

### 테스트

- `tests/status-progress.test.ts` 신규
- `tests/projection.test.ts`
- `tests/contract-flow.test.ts`
- `pnpm release:check`

### 완료 기준

- blocked run에서 다음 복구 명령이 status output에 나온다.
- completed run에서 evidence/gate summary가 한 화면에서 보인다.
- JSON output은 stable schema를 가진다.

### 구현 상태

완료.

- `src/progress/index.ts`가 run, phase, host event, gate, evidence gap, next command를
  stable progress schema로 정규화한다.
- `paveda status --run <id>`는 기존 ledger summary에 `progress`를 포함한다.
- `paveda status --run <id> --format markdown`은 blocked gate와 next evidence command를
  Markdown으로 출력한다.
- `paveda progress --run <id> [--watch]`와 `paveda handoff --run <id> --markdown`을 추가했다.
- Package smoke는 progress Markdown, JSON next command, handoff Markdown을 packaged CLI로 검증한다.

## PR 9. Advanced Risk/Security Verification Ladder

### 문제

Risk/security evidence kind와 gate 개념은 있지만, 실제 고급 검증 정책은 아직 얕다.
Release profile을 운영하려면 risk/security ladder가 명확해야 한다.

### 목표 상태

- Risk/security gate는 task type과 changed surface에 따라 required 여부를 결정한다.
- Security scan provider와 risk review provider가 release gate에 연결된다.
- Risk decision은 ledger decision과 policy violation에 남는다.

### 구현 작업

1. Task surface classifier
   - changed files와 task metadata를 기준으로 `auth`, `payment`, `data`, `infra`,
     `public-api`, `ui-only`, `docs-only` 같은 risk surface를 산출한다.

2. Gate policy
   - `security_scan`은 `auth`, `payment`, `data`, `infra`, `public-api`에서 release required다.
   - `risk_review`는 mixed/high-risk task에서 required다.
   - not_applicable은 release에서 기본 block하고, 낮은 risk surface에서만 approval로 허용한다.

3. Evidence provider
   - project-declared security command를 실행한다.
   - 수동 risk review는 template과 required fields를 가진다.

### 테스트

- `tests/risk-security.test.ts` 신규
- `tests/contract-flow.test.ts`
- `tests/conformance.test.ts`
- `pnpm release:check`

### 완료 기준

- high-risk release task는 security/risk evidence 없이는 block된다.
- low-risk docs task는 audited not_applicable 또는 not_required로 통과한다.
- Risk decision과 policy violation이 `status --run`에 보인다.

### 구현 상태

완료.

- `startPavedaDo`와 `runHostCommand`는 `changedFiles`와 `riskSurfaces`를 run context에 기록한다.
- `verifyRun`은 explicit `riskSurfaces`를 우선하고, 없으면 changed files/task type으로
  `auth`, `payment`, `data`, `infra`, `public-api`, `ui-only`, `docs-only`, `mixed`를 분류한다.
- Release `risk-gate`는 high-risk/mixed surface에서만 required이고, release `security-gate`는
  `auth`, `payment`, `data`, `infra`, `public-api`에서 required다.
- `verify --write`는 `risk.surface` decision과 blocked policy violation을 ledger에 기록한다.
- Release risk review evidence는 `reviewedBy`, `residualRisk`, `riskSurfaces` metadata를 요구한다.
- Security scan evidence는 project-declared command 또는 scanner metadata를 요구한다.
- Package smoke는 high-risk release task가 risk/security gate 없이는 block되는지 검증한다.

## PR 10. Ledger Search And Artifact Retention

### 문제

Ledger와 artifact store는 있지만, 많은 run이 쌓였을 때 검색과 보존 정책이 부족하다.

### 목표 상태

- Evidence, decisions, policy violations를 FTS5로 검색할 수 있다.
- Artifact retention/compaction policy를 설정할 수 있다.
- Optional vector index는 shared/user learning 단계에서만 도입한다.

### 구현 작업

1. Store
   - FTS5 virtual table을 추가한다.
   - schema migration은 기존 DB를 보존해야 한다.

2. CLI
   - `paveda search --query <text> [--run <id>]`
   - `paveda artifacts list --run <id>`
   - `paveda artifacts compact --before <duration> [--write]`

3. Retention policy
   - release artifact는 immutable retention을 기본으로 한다.
   - non-release raw artifact는 retention policy에 따라 compact 가능하다.
   - compact 후에도 ledger row와 hash summary는 남긴다.

### 테스트

- `tests/store.test.ts`
- `tests/artifacts.test.ts` 신규
- `tests/contract-flow.test.ts`
- `pnpm release:check`

### 완료 기준

- 검색은 evidence/rationale/decision/policy violation을 찾는다.
- Compact는 release artifact를 삭제하지 않는다.
- Compact 후 `status --run`은 artifact가 compacted 상태임을 보여준다.

### 구현 상태

완료.

- Store schema v4에 FTS5 `ledger_search` virtual table을 추가했다.
- `searchLedger()`는 evidence, decisions, policy violations를 FTS index로 검색한다.
- `paveda search --query <text> [--run <id>]`를 추가했다.
- `paveda artifacts list --run <id>`와
  `paveda artifacts compact --before <duration> [--run <id>] [--write]`를 추가했다.
- Artifact compact는 기본 dry-run이며 release immutable artifact는 `keep_release`로 보존한다.
- Compact된 artifact row는 원래 path/hash/byte length를 metadata `compacted`에 남긴다.
- Package smoke는 search, artifacts list, compact dry-run을 packaged CLI로 검증한다.

## 공통 검증 기준

각 PR은 최소한 다음을 만족해야 한다.

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm package:check
```

넓은 변경이나 release/profile/conformance 변경은 전체 gate를 실행한다.

```bash
pnpm release:check
```

새 CLI를 추가하면 `scripts/package-check.mjs` packaged smoke에 포함한다. Package smoke는
로컬 `dist`에 기대지 않고 tarball에 들어간 CLI와 assets만으로 성공해야 한다.

## 문서 갱신 기준

각 PR은 구현과 함께 다음 문서를 갱신한다.

- `docs/paveda-next-design-spec.md`: 구현 상태와 acceptance 변경
- `docs/paveda-next-architecture-notes.md`: 결정 변경 또는 Phase 2 항목 완료 상태
- `README.md`: 사용자가 직접 실행할 CLI가 추가되거나 바뀌는 경우
- `docs/release.md`: release/profile/conformance gate가 바뀌는 경우

문서에는 구현 로그를 길게 남기지 않는다. 현재 상태, 사용 방법, 검증 명령, 남은 제약만
짧게 기록한다.

## 작업 시작 권장 순서

다음 작업은 release profile activation이다. Release를 먼저 완성하면 advanced evidence,
risk/security ladder, CI report가 어떤 기준으로 필요한지 선명해진다.
