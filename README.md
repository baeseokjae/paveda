# paveda

> Portable policy runtime for agent workflows — common event model, host adapters, SQLite EventStore, PAL Router(/do 한정), and compatibility exports.

## Why

Paveda는 Claude Code, Codex, Hermes, Pi 같은 host가 같은 작업 규칙을 해석하도록 만드는 **policy runtime**이다. 소비 프로젝트의 `.claude`, `.codex`, `.pi`, `.hermes` 파일과 skill bundle은 host가 Paveda 런타임을 발견하고 호출하기 위한 compatibility export이며, 정책 판단의 기준은 `PolicyEngine`과 EventStore에 남는 decision이다.

## Status

`v0.1.0` release candidate — EventStore, policy runtime, signed policy bundle export/pull/cache, Claude Code/Codex/Hermes/Pi adapters, Codex installer, MCP gateway, PAL Router, project hooks/checks, and host compatibility bundle installers are implemented.

## Architecture (요약)

| 모듈 | 책임 |
|---|---|
| `src/core/` | 타입, 에러, 설정, 환경변수 로더 |
| `src/policy/` | 공통 AgentEvent, PolicyEngine, PolicyDecision, host capability matrix, signed policy bundle |
| `src/hook-runtime/` | 추상 lifecycle 이벤트 디스패치, profile gate, 개별 hook 토글 |
| `src/store/` | SQLite EventStore (events · sessions · router_decisions · instincts) + query CLI |
| `src/skill-loader/` | SKILL.md frontmatter 파서, scope priority(project > user > built-in) |
| `src/router/` | PAL Router (Frugal → Standard → Frontier), v0는 `/do` 한정 |
| `src/host-bundles/` | host별 compatibility export 렌더링 |
| `src/init/` | host bootstrap, hook settings, doctor 결과, 후속 검증 명령 연결 |
| `src/doctor/` | host readiness와 enforcement tier 점검 |
| `src/checks/` | project checks, runtime smoke, adoption report |
| `src/adapters/*/` | host lifecycle payload ↔ 공통 AgentEvent 매핑 |
| `src/mcp/` | policy-aware MCP wrapper tools |
| `assets/harness/` | compatibility bundle: core workflow skills plus optional portable skills |

설계 문서:

| 문서 | 역할 |
|---|---|
| [`docs/spec.md`](./docs/spec.md) | 전체 시스템 spec — 모듈 분리, EventStore 스키마, PAL Router, host bundle 모델, 설계 결정 |
| [`docs/architecture.md`](./docs/architecture.md) | 모듈별 동작 요약 |
| [`docs/adoption.md`](./docs/adoption.md) | 지원 host에 Paveda를 적용하는 dry-run/write 체크리스트 |
| [`docs/release.md`](./docs/release.md) | release gate와 smoke test 절차 |
| [`docs/decisions/`](./docs/decisions) | ADR 디렉토리 |

## Scripts

| 명령 | 동작 |
|---|---|
| `pnpm build` | `tsc` 컴파일 → `dist/` |
| `pnpm typecheck` | 타입 체크만 (`tsc --noEmit`) |
| `pnpm test` | Vitest 단발 실행 |
| `pnpm test:watch` | Vitest 워치 모드 |
| `pnpm lint` | Biome 검사 |
| `pnpm format` | Biome 포맷 적용 |
| `pnpm package:check` | tarball 생성 + 필수 파일/금지 경로/금지 문자열 검사 |
| `pnpm performance:check` | build 산출물 기준 EventStore/hook/skill loading 성능 smoke 실행 |
| `pnpm release:check` | typecheck/test/lint/build/performance/package check gate 실행 |

런타임 의존성은 v0 단계에선 비어 있다. SQLite EventStore는 Node 내장 `node:sqlite`를 사용한다. SKILL.md 파서·CLI 프레임워크 같은 의존성은 모듈을 채우면서 추가한다.

## Package Smoke Test

```bash
PAVEDA_PACK_DESTINATION=/private/tmp pnpm package:check
mkdir -p /private/tmp/paveda-pack-smoke
cd /private/tmp/paveda-pack-smoke
pnpm add /private/tmp/paveda-0.1.0.tgz
pnpm exec paveda help
pnpm exec paveda skills
pnpm exec paveda init --host codex --cwd /private/tmp/paveda-pack-smoke-project --write --force
pnpm exec paveda skills install do --cwd /private/tmp/paveda-pack-smoke-project
pnpm exec paveda skills install-bundle --host codex --cwd /private/tmp/paveda-pack-smoke-bundle --skills do,verify --write --force
pnpm exec paveda skills status --host codex --cwd /private/tmp/paveda-pack-smoke-bundle
pnpm exec paveda doctor --host codex --cwd /private/tmp/paveda-pack-smoke-project
pnpm exec paveda route --host codex --cwd /private/tmp/paveda-pack-smoke-project --skill do --ambiguity-score 0.25
pnpm exec paveda runtime-smoke --cwd /private/tmp/paveda-pack-smoke-project --json
pnpm exec paveda adoption-report --host codex --cwd /private/tmp/paveda-pack-smoke-project --runtime-smoke --json
pnpm exec paveda policy bundle \
  --issuer package-smoke \
  --generated-at 2026-06-01T00:00:00.000Z \
  --private-key /path/to/ed25519-private.pem \
  --key-id package-smoke-key \
  --write /path/to/paveda-policy.signed.json
pnpm exec paveda policy pull --source /path/to/paveda-policy.signed.json --keyring /path/to/policy-keyring.json --cache /private/tmp/paveda-policy-cache.json --write
pnpm exec paveda doctor --host codex --cwd /private/tmp/paveda-pack-smoke-project --policy-cache /private/tmp/paveda-policy-cache.json --enforcement --json
pnpm exec paveda adoption-report --host codex --cwd /private/tmp/paveda-pack-smoke-project --policy-cache /private/tmp/paveda-policy-cache.json --json
```

수동 policy smoke 명령은 signing key와 trusted keyring이 준비되어 있다는 전제다.
`pnpm package:check`는 임시 Ed25519 key와 keyring을 생성해 같은 bundle/pull/cache
흐름을 검증한다.

`pnpm package:check`는 위 수동 예시보다 넓게 검증한다. tarball에서 추출한
packaged CLI로 `harness`, `claude-code`, `codex`, `pi`, `hermes` 전체에 대해
`init`, `doctor`, `skills install-bundle --skills do,verify`, `skills status`를
실행하고, `adoption-report --runtime-smoke`로 각 host의 readiness와 EventStore
write/replay path를 확인한다. `claude-code` smoke는 hook settings 설치 경로도
함께 확인하고, packaged CLI의 `hook claude-code` dispatch가 EventStore에 기록되어
`events`/`status`로 다시 읽히는지도 확인한다. EventStore CLI smoke는 `--since`,
markdown write, failed-session exit gate, decision export도 확인한다. `skills
enable-router do`로 project `/do` override를 복구하는 흐름, concurrent route CLI
access, worktree port resolution, project check command execution도 packaged CLI로
확인한다. Codex smoke는 `/do` ambiguity gate까지 확인한다. Host asset smoke는
생성된 text asset 전체를 scan하여 stale host path, unadapted model tier,
unsupported model frontmatter를 차단하고, custom target에 설치된 `/specify`·`/do`
helper script를 실제 fixture로 실행한다.
Hook runtime smoke는 Codex, Hermes, Pi의 deny 응답도 각 host adapter가 기대하는
native block shape로 반환되는지 확인한다.

`pnpm performance:check`는 build된 라이브러리 API로 EventStore append 평균
latency, minimal hook dispatch 평균 overhead, 10개 skill loading cold path를
smoke 수준으로 측정하고 spec의 비기능 목표를 넘으면 실패한다.

기대값:
- tarball에 `dist/`, `assets/harness/`, `README.md`, `CHANGELOG.md`,
  `LICENSE`, `package.json`이 포함된다.
- tarball에 `assets/harness/AGENTS.md` canonical instruction file이 포함된다.
- tarball에 `assets/harness/context-modules/*.md` canonical context modules가 포함된다.
- `pnpm exec paveda help`가 CLI 도움말을 출력한다.
- packaged builtin core skills(`/do`, `/specify`, `/plan`, `/verify`, `/debug`, `/commit`, `/pr`, `/surgical-edits`)가 로드된다.
- optional portable skills(`/docs-writer`, `/review`, `/browser-validate`, `/dead-code`)는 `--include-optional` 또는 명시적 `--skills`로 설치된다.
- `runtime-smoke`가 synthetic hook session을 EventStore에 기록하고 replay/status materialization을 확인한다.
- `adoption-report`가 host readiness, policy source, `/do` route gate, runtime smoke를 한 JSON으로 요약하고, doctor 실패 시 실패한 체크 이름과 경로를 포함한다.
- `init --host <host> --write`가 host bundle, context modules, instruction file을 생성하고 doctor 결과를 반환한다.
- builtin skill install dry-run target이 `.harness/skills/do/SKILL.md`로 표시되고, `--write` 시 전체 skill directory가 설치된다.
- `skills enable-router do --write`가 project `/do` override에 router metadata를 추가하고 명시된 ambiguity threshold를 반영한다.
- Host bundle write는 host별 instruction file과 context modules를 생성하고 compatibility paths를 target host paths로 렌더링한다.
- Host bundle smoke는 생성된 skill/context/instruction text에 stale host path가 남지 않는지 확인한다.
- Host bundle smoke는 host별 model metadata가 맞게 렌더링되는지 확인한다.
- Custom target smoke는 설치된 helper scripts가 sibling assets와 fixtures를 정상적으로 찾는지 확인한다.
- `skills status --host <host>`에서 `/do`와 `/verify`가 project scope로 선택된다.
- `hook claude-code` smoke가 lifecycle events와 completed session summary를 EventStore에 남긴다.
- `hook codex`, `hook hermes`, `hook pi`가 synthetic destructive/sensitive-file action에 대해 host-native deny/block 응답을 반환한다.
- `port`와 `check`가 packaged CLI에서 각각 deterministic port output과 `.harness/checks` execution result를 반환한다.
- Codex bundle은 각 skill에 `agents/openai.yaml`도 생성한다.
- Hermes bundle은 `.hermes/config.yaml`에 설치된 skill root를 등록한다.
- `doctor --host <host>`가 host skill root, context modules, instruction file, model metadata, `/do` router metadata, Codex skill metadata, Claude Code hook settings, project hook/check 상태를 점검한다.
- ambiguity gate smoke가 `blocked: true`를 반환한다.
- `policy bundle`/`policy pull`이 rule metadata, host capability matrix, canonical SHA-256 digest를 포함한 deterministic JSON artifact를 생성하고, trusted keyring 검증 후 cache envelope을 기록한다.
- `doctor --enforcement --policy-cache`와 `adoption-report --policy-cache`가 현재 verified policy source digest/key metadata와 `runtimeDrift.ok: true`를 노출한다.

## Claude Code Hook Install

```bash
pnpm build
node dist/cli.js install claude-code
node dist/cli.js install claude-code --write
node dist/cli.js install claude-code --cli-path /path/to/paveda/dist/cli.js --write
node dist/cli.js install claude-code --profile strict --session-start-max-chars 4000 --write
node dist/cli.js install claude-code --session-start-context off --write
node dist/cli.js install claude-code --project-hooks --write
node dist/cli.js install codex
node dist/cli.js install codex --write
node dist/cli.js install codex --managed --write
node dist/cli.js install codex --managed --requirements-path requirements.toml --force --write
node dist/cli.js install hermes --write
node dist/cli.js install hermes --auto-accept-hooks --write
node dist/cli.js install pi --write
```

명시적 `--command`가 없으면 CLI installer는 현재 실행 중인 CLI 경로로 hook command를 만든다. 기존 `.claude/settings.json`의 다른 설정과 hook은 보존한다. installer는 기본 `env`로 `PAVEDA_HOOK_PROFILE=standard`, `PAVEDA_SESSION_START_MAX_CHARS=8000`도 병합한다.
다른 경로를 고정해야 하는 프로젝트는 `--cli-path`로 `dist/cli.js`를 명시할 수 있다.
SessionStart git context를 끄려면 `--session-start-context off`를 사용한다.
프로젝트 소유 `.harness/hooks` 실행은 보안상 기본 비활성화다. 신뢰한 프로젝트에서만 `--project-hooks` 또는 `PAVEDA_PROJECT_HOOKS=on`으로 명시적으로 켠다.
installer 결과의 `changed`와 `summary.hooks[]`를 보면 dry-run 상태에서 실제 write 필요 여부와 각 Claude Code hook event 설치 여부를 확인할 수 있다.

Codex installer는 `.codex/hooks.json`에 Paveda command hook을 설치한다.
`--managed`를 붙이면 `requirements.toml`에 managed hook directory, hook feature
pinning, `allow_managed_hooks_only`, sandbox/approval/web-search constraints, command
rule block을 포함한 Paveda managed policy block을 생성한다. 기존
`requirements.toml`에 Paveda block이 없으면 `--force` 없이 덮어쓰거나 append하지
않는다.
Hermes installer는 `.hermes/config.yaml`의 `hooks:` 섹션에 Paveda shell hook을
병합하고 `.hermes/agent-hooks/paveda-policy.sh`를 생성한다. Hermes의 hook consent
모델을 자동 승인하려면 `--auto-accept-hooks`를 명시한다. Pi installer는
`.pi/extensions/paveda-policy.ts` project-local extension을 생성하고 `tool_call`
응답의 `{ block: true }`로 Paveda deny decision을 전달한다.

## Skill Install

```bash
node dist/cli.js skills
node dist/cli.js skills status
node dist/cli.js skills status --host codex
node dist/cli.js skills enable-router do
node dist/cli.js skills enable-router do --write
node dist/cli.js skills install do
node dist/cli.js skills install do --write
node dist/cli.js skills install-bundle --host codex
node dist/cli.js skills install-bundle --host codex --include-optional
node dist/cli.js skills install-bundle --host codex --skills docs-writer,review
node dist/cli.js skills install-bundle --host pi --write
node dist/cli.js init --host codex --cwd /path/to/project
node dist/cli.js init --host codex --cwd /path/to/project --write
node dist/cli.js init --host claude-code --cwd /path/to/project --cli-path /path/to/paveda/dist/cli.js --write
node dist/cli.js adoption-report --host codex --cwd /path/to/project
node dist/cli.js adoption-report --host codex --cwd /path/to/project --runtime-smoke --json
node dist/cli.js adoption-report --host codex --cwd /path/to/project --policy-cache .harness/policy-cache.json --json
node dist/cli.js doctor --host codex --cwd /path/to/project
node dist/cli.js doctor --host codex --cwd /path/to/project --json
node dist/cli.js doctor --host codex --cwd /path/to/project --policy-cache .harness/policy-cache.json --enforcement --json
```

`init`은 host bundle 설치와 `doctor` 점검을 하나로 묶는다. 기본은 dry-run이며
`--write`를 붙여야 파일을 쓴다. `--host claude-code`일 때는 Claude Code hook
settings도 함께 병합한다.
`init` 결과의 `nextCommands[]`는 `doctor`, `skills status`, `/do` route check,
`runtime-smoke`까지 이어지는 후속 검증 명령을 제공한다. dry-run 결과에는
검토 후 실행할 `init --write` 명령도 포함된다. CLI로 실행한 경우 후속 명령과
doctor/adoption-report 복구 명령은 현재 실행 중인 CLI 경로를 사용한다.
`adoption-report`는 같은 검증 흐름을 하나로 묶어 보여준다. 기본은 읽기 전용이고,
EventStore write path까지 확인하려면 `--runtime-smoke`를 명시한다.
`skills status`는 selected/shadowed skill 후보와 router 활성 여부를 보여준다. `--host codex`처럼 host를 지정하면 해당 host skill root의 생성 산출물을 우선 검사한다. `skills install`은 기본 dry-run이며, `--write`를 붙이면 manifest에 선언된 Paveda builtin skill directory 전체를 `.harness/skills/<name>/`로 복사한다.
`skills install-bundle`은 `assets/harness/manifest.json`에 선언된 core workflow skills 전체 또는 `--skills do,verify`로 지정한 일부를 host별 기본 skill root에 설치한다. Optional skills는 기본 설치에서 제외되며, `--include-optional`로 모두 포함하거나 `--skills docs-writer,review`처럼 명시적으로 선택한다. 기본 target은 `harness=.harness/skills`, `claude-code=.claude/skills`, `codex=.codex/skills`, `pi=.pi/skills`, `hermes=.hermes/skills`다. `--target-root`를 직접 지정하면 상대 경로는 `--cwd` 기준으로 해석되고, 생성된 skill path reference와 Hermes `skills.external_dirs`도 실제 설치 위치를 사용한다. 같은 custom root를 검증하려면 `doctor`, `skills status`, `route`, `adoption-report`에도 동일한 `--target-root`를 전달한다. 설치 시 skill/context/instruction path는 target host에 맞게 렌더링하고, project hook/check extension path는 Paveda 런타임이 실행하는 `.harness/hooks`, `.harness/checks`로 유지한다. instruction과 context modules도 manifest 기준으로 host별 위치에 복사된다. `assets/harness/AGENTS.md`도 host instruction file로 렌더링된다: `harness=.harness/AGENTS.md`, `claude-code=.claude/CLAUDE.md`, `codex=AGENTS.md`, `pi=.pi/AGENTS.md`, `hermes=.hermes/AGENTS.md`. Codex bundle은 각 skill에 `agents/openai.yaml`도 생성하고, Hermes bundle은 `.hermes/config.yaml`의 `skills.external_dirs`에 설치된 skill root를 등록한다.
`skills enable-router do`도 기본 dry-run이며, `--write`를 붙이면 선택된 `/do` skill의 `SKILL.md` frontmatter에 `router: enabled`와 `ambiguity-required`를 추가한다.
Packaged builtin harness는 core workflow인 `/do`, `/specify`, `/plan`, `/verify`, `/debug`, `/commit`, `/pr`, `/surgical-edits`와 optional portable skills인 `/docs-writer`, `/review`, `/browser-validate`, `/dead-code`를 포함한다. `/specify`는
goal/constraint/ontology clarity를 0~1로 평가하고, `/do`는 선택된 skill의
`ambiguity-required` 임계값보다 높은 `--ambiguity-score`를 받으면
`blocked: true`로 진입을 막는다.
`doctor`는 host bundle 산출물, context modules, host별 model metadata, `/do`
router metadata, Codex skill discovery metadata, Claude Code hook 설정, 프로젝트
hook/check executable 상태를 읽기 전용으로 점검한다. 프로젝트 hook/check
스크립트는 실행하지 않는다. 실패한 체크는 가능한 경우 `recovery.command`로
실행 가능한 복구 명령을 함께 반환한다.
`--enforcement`를 붙이면 host/action별 effective enforcement tier(`block`,
`gate`, `mediate`, `verify`), bypass path, 필요한 remediation, managed config
상태(Codex), native adapter config file 경로(Hermes/Pi)를 함께 보고한다.
`--policy-cache`를 함께 전달하면 `policy-source` check가 cache envelope을 검증하고
bundle rule/host metadata가 현재 로컬 runtime과 drift 없는지도 비교한다. 각
enforcement probe detail에도 같은 source/digest/key metadata가 포함된다.
`adoption-report --policy-cache`도 같은 `policy-source` check를 포함한다.

## Policy Bundle

```bash
node dist/cli.js policy bundle --issuer local --write /tmp/paveda-policy.json
node dist/cli.js policy bundle --issuer control-plane --private-key /path/to/ed25519-private.pem --key-id prod-1 --write /tmp/paveda-policy.signed.json
node dist/cli.js policy verify --bundle /tmp/paveda-policy.signed.json --public-key /path/to/ed25519-public.pem
node dist/cli.js policy verify --bundle /tmp/paveda-policy.signed.json --keyring /path/to/policy-keyring.json
node dist/cli.js policy pull --source https://policy.example.invalid/paveda-policy.signed.json --keyring /path/to/policy-keyring.json --cache .harness/policy-cache.json --write
```

`policy bundle`은 현재 runtime rule metadata와 host capability matrix를
deterministic JSON artifact로 export하고 `canonicalSha256` digest를 포함한다.
`--private-key`를 전달하면 Ed25519 detached signature를 추가하고,
`policy verify`는 digest drift, key mismatch, signature mismatch를 분리해서
보고한다. `policy pull`은 path, `file://`, `http://`, `https://` source에서
signed bundle을 가져온 뒤 trusted keyring으로 검증하고, `--cache --write`가
있을 때 검증 결과와 signed bundle을 cache envelope으로 저장한다.

## Environment

```bash
export PAVEDA_HOOK_PROFILE=standard          # minimal | standard | strict
export PAVEDA_DISABLED_HOOKS="tool.execute.before:Bash:harness.destructive.guard"
export PAVEDA_PROJECT_HOOKS=off              # on으로 설정해야 .harness/hooks 실행
export PAVEDA_SESSION_START_MAX_CHARS=4000   # 기본 8000
export PAVEDA_SESSION_START_CONTEXT=off      # 완전 비활성화 옵션
export PAVEDA_COST_GUARD_MAX_MINUTES=120
export PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD=5
export PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL=3
export PAVEDA_POLICY_CACHE=.harness/policy-cache.json
```

`strict` profile은 cost guard 기본값을 더 민감하게 적용한다:
`PAVEDA_COST_GUARD_MAX_MINUTES=60`,
`PAVEDA_COST_GUARD_AGENT_WARNING_THRESHOLD=3`,
`PAVEDA_COST_GUARD_AGENT_COMPACT_INTERVAL=2`. 명시적으로 설정한 env 값은
profile 기본값보다 우선한다.
`PAVEDA_POLICY_CACHE`를 설정하면 hook runtime이 검증된 policy cache envelope을
읽고, 각 `PolicyEvaluation`과 `policy.decision` evidence에 bundle digest/key
metadata를 남긴다.

## EventStore Status

```bash
node dist/cli.js status
node dist/cli.js status --cwd /path/to/project --since 1h
node dist/cli.js status --store-scope user
node dist/cli.js status --markdown
node dist/cli.js status --markdown --write /tmp/paveda-status.md
node dist/cli.js status --status failed --exit-code
node dist/cli.js runtime-smoke --cwd /path/to/project
node dist/cli.js runtime-smoke --cwd /path/to/project --store-scope user --json
node dist/cli.js runtime-smoke --cwd /path/to/project --db /tmp/paveda-runtime-smoke.db --json
node dist/cli.js events --cwd /path/to/project --session <id> --since 30m
node dist/cli.js router-trace --cwd /path/to/project --session <id> --since 2026-05-22T00:00:00Z
node dist/cli.js route --skill do --ambiguity-score 0.25
node dist/cli.js route --host codex --cwd /path/to/project --skill do --ambiguity-score 0.25
node dist/cli.js export-decisions --cwd /path/to/project --skill do --since 7d
node dist/cli.js export-decisions --markdown --write /tmp/paveda-decisions.md
node dist/cli.js instincts add --scope project --pattern "Run focused tests first" --confidence 0.8
node dist/cli.js instincts --scope project --status active
node dist/cli.js instincts set-status --id 1 --status promoted
node dist/cli.js mcp serve --cwd /path/to/project
```

`mcp serve`는 stdio JSON-RPC MCP gateway를 열고 `paveda.search`,
`paveda.read`, `paveda.patch`, `paveda.shell`, `paveda.git`, `paveda.test` wrapper
tool을 노출한다. 각 tool call은 `AgentEvent`로 정규화되고 `PolicyEngine`과
EventStore 기록을 통과한 뒤, deny decision이 enforced된 경우 실행 전에 차단된다.

`--markdown` renders a compact session table for reports. `--write` saves the
rendered status instead of printing it. `--exit-code` exits non-zero when the
selected sessions include a failed session, which makes it usable as a simple CI
gate. `--since` accepts relative values such as `30m`, `1h`, and `7d`, ISO
timestamps, or epoch milliseconds.
For EventStore-backed commands, `--db` selects an explicit store and otherwise
`--cwd` selects `<project>/.harness/store.db`. Use `--store-scope user` to
select `~/.harness/store.db` for cross-project operational history.
`runtime-smoke` writes a synthetic `SessionStart` + `PreToolUse` + `Stop` hook
session to the selected EventStore and verifies replay plus session summary
materialization.
It does not execute project-owned `.harness/hooks`.
Event payloads with `costUsd` or `cost_usd` update the session summary's
`costUsd` value, which is shown in JSON and markdown status output.
The EventStore CLI and library API also record instinct patterns, list them by
scope/status, update their lifecycle status, and expire pending or active
records when their TTL has elapsed.
`export-decisions` turns recent `router_decisions` rows into external decision
candidate records without writing to any external store directly.

## Non-Goals

- 프로젝트 도메인 hook(예: `docs-final-check`, `wiki-lint`, `domain-sync-check`) — 각 프로젝트가 자율 관리.
- 도메인 지식 저장소 — Paveda는 EventStore 기반 운영 lineage만 담당한다.
- 모델/provider 실행 엔진 — Paveda v0는 routing decision과 host bundle 생성을 담당한다.

## License

MIT
