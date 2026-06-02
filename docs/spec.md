---
title: "Paveda Policy Runtime — System Spec"
date: 2026-05-15
status: current
type: spec
tags: [policy-runtime, host-adapters, eventstore, cli]
decisions:
  - 별도 오픈소스 프로젝트(repo)로 신규 구축.
  - EventStore는 운영 lineage만 담당하고, 도메인 지식 저장소는 외부 시스템으로 분리.
  - PAL Router는 /do 한정 적용. 다른 skill은 SKILL.md frontmatter `model:` tier 수동 지정 유지.
  - Host bundle target은 harness, claude-code, codex, pi, hermes를 지원한다.
  - Signed policy bundle은 control-plane 배포 artifact이며 trusted keyring 검증 후 cache한다.
---

# Paveda Policy Runtime — 설계 스펙

## 1. 개요

### 1.1 목적

Paveda는 agent workflow를 **단독 오픈소스 policy runtime**으로 제공한다. 이 런타임은:

- `PolicyEngine`, 공통 `AgentEvent`/`PolicyDecision`, host capability matrix, EventStore lineage를 권위 있는 정책 판단 경로로 둔다.
- Runtime rule version/fingerprint metadata와 host capability matrix를 signed policy bundle로 export하고, remote/file source에서 pull한 bundle을 trusted keyring으로 검증한다.
- 호스트별 agent runtime에 설치되는 adapter/hook 설정, skill loader, hook profile, EventStore, PAL Router 등과 core workflow skills(`/do`, `/specify`, `/plan`, `/verify`, `/debug`, `/commit`, `/pr`, `/surgical-edits`)를 함께 제공한다.
- Optional portable skills(`/docs-writer`, `/review`, `/browser-validate`, `/dead-code`)는 기본 설치에서 제외하고 명시적으로 선택한 경우에만 host bundle에 렌더링한다.
- 소비 프로젝트의 `.claude`, `.codex`, `.pi`, `.hermes` 파일은 Paveda installer가 생성/갱신하는 host별 compatibility export다.
- 프로젝트 도메인 hook/skill은 core harness 영역 밖이며, project pack 또는 local override로 관리한다.

### 1.2 3대 설계 기준 (재확인)

1. **Context 정확성** — 각 flow의 컨텍스트가 정확히 유지.
2. **속도** — 하네스 호출 cold start 최소, dispatch latency 짧음.
3. **Skill 간 유기적 소통** — 내부 skill 끼리 상태/결과를 명확히 전달.

## 2. 프로젝트 메타

### 2.1 결정된 사항

| 항목 | 결정 |
|---|---|
| 적용 범위 | 별도 신규 프로젝트(repo) |
| EventStore와 도메인 지식 저장소의 관계 | 역할 분리 — 운영 lineage = EventStore, 도메인 지식 = 외부 시스템 |
| PAL Router 적용 범위 | `/do` 한정 |
| 영속 저장소 1순위 | SQLite EventStore (단일 파일, Node 내장 SQLite) |
| Hook 분류 | 하네스 운영 hook 7개 + 프로젝트 도메인 hook은 별도 |

### 2.2 결정 사항 (§9에서 상세화)

| 항목 | 결정 |
|---|---|
| 프로젝트 이름 | `paveda` |
| 구현 언어 | TypeScript |
| 제공 형태 | JS package + CLI |
| repo 위치 | public GitHub repo |

---

## 3. 하네스 아키텍처

### 3.1 주요 모듈 분리

```
src/
├── core/             # 타입, 에러, 설정, 환경변수 로더
├── policy/           # AgentEvent, PolicyEngine, PolicyDecision, HostCapability, bundle
├── hook-runtime/     # hook profile, lifecycle dispatch, gate
├── store/            # SQLite EventStore + query CLI
├── skill-loader/     # SKILL.md 발견·로딩·frontmatter 파싱
├── router/           # PAL Router (Frugal/Standard/Frontier 3-tier)
├── host-bundles/     # compatibility assets를 host별 산출물로 렌더링
├── init/             # host bootstrap + doctor orchestration
├── doctor/           # host bundle/readiness 점검
├── checks/           # project checks, runtime smoke, adoption report
└── adapters/
    ├── claude-code/  # Claude Code hook spec 매핑
    ├── codex/        # Codex hook spec 매핑
    ├── hermes/       # Hermes hook/plugin payload 매핑
    └── pi/           # Pi extension event 매핑

assets/
└── harness/          # compatibility bundle
```

각 모듈은 명확한 단일 책임을 갖는다.

### 3.2 데이터 경로

```
호스트(Claude Code/Codex/Hermes/Pi)
  └─ host adapter
      └─ AgentEvent
          └─ PolicyEngine
              ├─ PolicyDecision
              └─ EventStore(events + policy_decisions)
                              (선택) skill-loader가 trigger 매칭
                                       │
                                       ▼
                                    router (/do만 PAL 평가)
                                       │
                                       ▼
                                  host runtime에서 skill 실행
                                       │
                                       ▼
                                  결과 → store (events append)
                                       │
                                       ▼
                          (선택) 외부 도메인 지식 저장소에 결정 후보 기록
```

Control plane distribution path:

```
policy bundle source(path/file/http)
  └─ SignedPolicyBundle
      └─ trusted keyring + canonicalSha256 verification
          └─ policy cache envelope
```

EventStore와 외부 도메인 지식 저장소는 **서로 모른 채로** 동작한다. 연결이
필요하면 별도 CLI나 skill이 EventStore export 결과를 읽어 외부 시스템에 맞게
변환한다.

---

## 4. Hook 시스템 명세

### 4.1 하네스 운영 hook (7개)

새 하네스가 책임지는 hook. 어느 프로젝트에든 적용 가능한 범용성을 갖는다.

| ID | 트리거 | 책임 |
|---|---|---|
| `harness.session.context` | SessionStart | 브랜치/커밋/working tree 상태 주입. SessionStart context 상한(`MAX_CHARS`)으로 토큰 폭증 방지. |
| `harness.cost.guard` | PostToolUse / Agent | Agent 스폰 수·세션 경과 시간 추적. 임계값 초과 시 `/compact` 권고. EventStore에 누적. |
| `harness.test.process.cleanup` | PostToolUse / Bash | test command 이후 남은 test worker process 정리. |
| `harness.destructive.guard` | PreToolUse / Bash plus file mutation companion | `.env` 쓰기, `DROP TABLE`, `rm -rf`, secret key file 생성 같은 위험 패턴 차단 (D-001~D-006). |
| `harness.blast.check` | PreToolUse / Edit\|Write\|apply_patch | `package.json`, `pyproject.toml` 등 의존성 manifest 변경 감지 → 알림. |
| `harness.tooling.enforce` | PreToolUse / Bash | `cat`/`grep`/`find`/`sed` 직접 사용 → `Read`/`Grep`/`Glob`/`Edit` 대체 강제. |
| `harness.worktree.port` | (직접 실행/API) | 워크트리 이름 기반 결정론적 포트 할당 (충돌 방지). |

### 4.2 프로파일 시스템

환경변수로 hook 활성도 제어:

```bash
export PAVEDA_HOOK_PROFILE=standard           # minimal | standard | strict
export PAVEDA_DISABLED_HOOKS="tool.execute.before:Bash:harness.destructive.guard"
export PAVEDA_PROJECT_HOOKS=off               # on일 때만 프로젝트 .harness/hooks 실행
export PAVEDA_SESSION_START_MAX_CHARS=4000    # 기본 8000
export PAVEDA_SESSION_START_CONTEXT=off       # 완전 비활성화 옵션
export PAVEDA_POLICY_CACHE=.harness/policy-cache.json # verified bundle cache metadata 연결
```

프로파일별 활성 hook:

| 프로파일 | 활성 hook | 용도 |
|---|---|---|
| `minimal` | session.context (요약만), destructive.guard | 빠른 prompt 응답, 저비용 세션 |
| `standard` | 7개 전부 | 기본값 |
| `strict` | 7개 + `hook.verbose` EventStore 로깅 + cost.guard 임계값 강화 (`60m`, agent `3`, interval `2`) | CI/배포 직전 검증 |

**Cache 보호 원칙**: `HOOK_PROFILE` 변경은 세션 시작 시점에만 평가. 세션 중 동적 변경 금지 → tool list 안정성 보장.

### 4.3 프로젝트 도메인 hook (하네스 밖)

다음은 **각 프로젝트가 자율 관리**. 하네스는 이들을 로드할 수 있는 표준 경로만 제공:

- 프로젝트별 예: `docs-final-check`, `wiki-lint`, `domain-sync-check`, `cleanup-test-processes`, `verify-playwright-setup`.
- 하네스는 `project/.harness/hooks/` 같은 표준 경로를 약속만 하고, 실제 hook은 프로젝트가 작성.

### 4.4 lifecycle 추상 이벤트

호스트별 hook 이름을 추상 이벤트로 매핑:

| 추상 이벤트 | Claude Code | Codex | Hermes | Pi |
|---|---|---|---|---|
| `session.created` | SessionStart | SessionStart | on_session_start | session_start |
| `prompt.submitted` | UserPromptSubmit | UserPromptSubmit | pre_llm_call / pre_gateway_dispatch | input / before_agent_start |
| `tool.execute.before` | PreToolUse | PreToolUse / PermissionRequest | pre_tool_call | tool_call |
| `tool.execute.after` | PostToolUse / PostToolUseFailure | PostToolUse | post_tool_call / transform_tool_result | tool_result / tool_execution_end |
| `session.completed` | Stop / SessionEnd | Stop | on_session_end | session_shutdown |

Host bundle installer는 별도 레이어로 `harness`, `claude-code`, `codex`, `pi`,
`hermes` compatibility 산출물을 생성한다.

---

## 5. SQLite EventStore 명세

### 5.1 위치와 형태

```
~/.harness/store.db            # 사용자 글로벌 (cross-project 운영 메트릭)
<project>/.harness/store.db    # 프로젝트 로컬 (해당 프로젝트 lineage)
```

- 두 store는 독립. 글로벌은 cross-project 비용/시간 분석, 로컬은 lineage·재구성용.
- 단일 SQLite 파일 → 백업/이동/삭제 단순. 추가 인프라 0.

### 5.2 스키마

```sql
-- 1. 모든 lifecycle 이벤트의 단일 append-only 로그
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                  -- unix epoch ms
  type TEXT NOT NULL,                   -- session.created | tool.execute.before |
                                        -- tool.execute.after | session.completed |
                                        -- hook.fired | config.snapshot | skill.invoked |
                                        -- router.escalate
  payload TEXT NOT NULL                 -- JSON
);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_type ON events(type, ts);

-- 2. 세션 요약 (events에서 materialize)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cost_usd REAL DEFAULT 0,
  agent_spawns INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' -- active | completed | failed | compacted
);

-- 3. /do 세션의 PAL Router 결정 lineage
CREATE TABLE router_decisions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  skill TEXT NOT NULL,                  -- 현재는 항상 'do' (한정 적용)
  tier TEXT NOT NULL,                   -- frugal | standard | frontier
  reason TEXT,                          -- start | escalate:<cause> | downgrade:<cause>
  result TEXT                           -- success | retry | abort
);

-- 4. Policy decision lineage
CREATE TABLE policy_decisions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  action TEXT NOT NULL,
  severity TEXT NOT NULL,
  tier TEXT NOT NULL,
  enforced INTEGER NOT NULL,
  reason TEXT NOT NULL,
  required_capability TEXT NOT NULL,
  suggested_remediation TEXT,
  evidence TEXT NOT NULL
);

-- 5. (선택) Instinct 저장
CREATE TABLE instincts (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,                  -- project | user
  pattern TEXT NOT NULL,
  evidence TEXT,
  examples TEXT,
  confidence REAL NOT NULL,
  ttl_expires_at INTEGER,               -- 30일 TTL
  status TEXT NOT NULL DEFAULT 'pending'-- pending | active | promoted | expired
);

-- 6. Store schema migration ledger
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

### 5.3 API (CLI + 라이브러리)

```bash
# CLI — 운영 가시성
paveda status                           # 현재 세션 요약(JSON)
paveda status --markdown --write out.md
paveda status --status failed --exit-code # CI 게이트용
paveda status --cwd <project> --since 1h
paveda status --store-scope user        # ~/.harness/store.db 조회
paveda runtime-smoke --cwd <project> --json
paveda runtime-smoke --cwd <project> --store-scope user --json
paveda adoption-report --host <host> --cwd <project> --runtime-smoke --json
paveda adoption-report --host <host> --cwd <project> --policy-cache .harness/policy-cache.json --json
paveda events --cwd <project> --session <id> --since 1h
paveda router-trace --cwd <project> --session <id> --since 7d # /do의 PAL 결정 lineage
paveda export-decisions --cwd <project> --skill do --since 7d --markdown --write decisions.md
paveda instincts add --scope project --pattern "Run focused tests first" --confidence 0.8
paveda instincts --scope project --status active
paveda instincts set-status --id 1 --status promoted
paveda policy bundle --issuer local --write policy.json
paveda policy verify --bundle policy.signed.json --keyring policy-keyring.json
paveda policy pull --source https://policy.example.invalid/paveda-policy.signed.json --keyring policy-keyring.json --cache .harness/policy-cache.json --write
paveda doctor --host <host> --enforcement --policy-cache .harness/policy-cache.json --json
```

라이브러리 인터페이스(언어 무관 의사 코드):

```
store.append(event_type, session_id, payload)
store.replay(session_id) -> List[Event]    # lineage 재구성
store.summarize_session(session_id) -> Session
store.router_lineage(session_id) -> List[RouterDecision]
store.append_instinct(scope, pattern, confidence, ttl_expires_at?)
store.list_instincts(scope?, status?, include_expired?) -> List[Instinct]
store.update_instinct_status(id, status) -> Instinct?
```

### 5.4 외부 도메인 지식 저장소와의 인터페이스

EventStore는 도메인 지식 저장소를 직접 알지 않는다. 연결은 **별도 skill 또는 CLI 작업**이 담당한다:

- `paveda export-decisions` → 최근 router_decisions를 결정 후보 레코드로 export.
- 외부 skill이 EventStore export와 도메인 지식 저장소를 함께 조회하여 합성된 보고서를 작성.

이 분리로 EventStore는 단순하게 유지되고, 도메인 지식 저장소도 운영 데이터로
오염되지 않는다.

---

## 6. PAL Router 명세 (`/do` 한정)

### 6.1 동작

```
do 세션 시작
├─ tier = frugal
├─ skill 실행
│   ├─ 성공 → router_decisions.append(tier=frugal, result=success)
│   │       └─ 다음 do 세션에서도 frugal 유지
│   └─ 실패 패턴 감지 → tier = standard
│       ├─ skill 재시도
│       │   ├─ 성공 → router_decisions.append(tier=standard, result=success)
│       │   └─ 실패 → tier = frontier
│       │       └─ 마지막 시도
```

### 6.2 실패 패턴 (escalation 트리거)

| 신호 | 임계값 | 결과 |
|---|---|---|
| Tool call 재시도 | 3회 초과 | escalate |
| `/verify` 실패 | 1회 | escalate |
| Ambiguity score 재상승 | 0.3 초과 | escalate |
| 작업 30분 초과 | 30 min | escalate (옵션) |

### 6.3 다운그레이드

- 연속 3개 do 세션이 현재 tier에서 성공 → 1단계 다운그레이드 시도.
- 다운그레이드 후 실패 시 즉시 원래 tier로 복귀.

### 6.4 다른 skill과의 관계

- `/do` 외 다른 skill은 PAL Router 비활성. SKILL.md frontmatter의 `model:` tier 지정 그대로 유지.
- 향후 적용 범위 확대는 router_decisions 로그를 보고 effect-size 측정 후 결정.

---

## 7. Skill Loader 명세

### 7.1 SKILL.md 표준

Host-compatible `SKILL.md` frontmatter를 수용:

```yaml
---
name: do
description: ...
model: standard
allowed-tools: ...
disable-model-invocation: false
---
```

추가 필드 (옵션):

```yaml
router: enabled           # PAL Router 적용 여부 (do만 true)
trigger:
  paths: [src/**/*.ts]    # 작업 파일 매칭 시 자동 활성화
  keywords: [구현, 만들어]  # 키워드 매칭
ambiguity-required: 0.2   # 진입 전 specify 점수 임계값 (do만)
```

### 7.2 Scope priority

로드 순서:

```
1. <project>/.harness/skills/<name>/SKILL.md        (project override, 최우선)
2. <project>/.claude/skills/<name>/SKILL.md         (Claude Code host override)
3. ~/.harness/skills/<name>/SKILL.md                (user override)
4. <paveda package>/assets/harness/skills/<name>/SKILL.md  (canonical builtin)
```

같은 name이면 project가 user를 override, user가 canonical builtin을 override한다.
중요한 점은 Paveda가 local project skill에 의존해 동작하는 구조가 아니라는 것이다.
`assets/harness/skills`의 canonical bundle이 기본 harness이며, `.harness/skills`와
`.claude/skills`는 프로젝트가 명시적으로 바꾸고 싶은 경우의 확장점이다.
기본 discovery 대상이 아닌 skill root는 CLI/라이브러리의 명시적 root 옵션으로만 포함한다.

### 7.3 Specify ambiguity 게이트

`/specify` 결과에 ambiguity score 0~1을 포함:

```
ambiguity = 1 - (0.5 × goal_clarity + 0.3 × constraint_clarity + 0.2 × ontology_clarity)
```

- `/do`는 진입 전 `ambiguity ≤ 0.2` 게이트 통과 필요.
- 0.2 초과면 `/specify` 재진행 유도 (블로킹).
- 점수와 가중치 산출은 specify 출력의 LLM 자체 평가 (외부 의존 0).

---

## 8. 프로젝트 도입 경로

Paveda는 다음 순서로 소비 프로젝트에 도입한다:

### Phase A — 하네스 패키지 구축

1. 주요 모듈 골격 작성.
2. 하네스 운영 hook 7개를 모듈화.
3. SQLite EventStore + 기본 CLI 구현.
4. core workflow skills를 `assets/harness/skills`에 패키징.
5. Skill Loader, PAL Router (`/do` 한정) 구현.
6. Claude Code adapter 1차 완성.
7. Codex/pi/Hermes host skill bundle installer 추가.
8. Signed policy bundle export/verify/pull/cache 추가.
9. Hook runtime, doctor, adoption-report에 verified policy source metadata 연결.
10. Doctor/adoption policy-source check에서 bundle rule/host metadata와 local runtime drift 검증.

### Phase B — 소비 프로젝트 도입

1. 대상 프로젝트에 하네스 설치 (`paveda init --host ... --write`).
2. Host-local 중복 harness hook 제거 → Paveda hook runtime이 제공.
3. core workflow skills는 Paveda builtin 또는 installer-managed 산출물로 대체.
4. 프로젝트 도메인 hook/skill은 `.harness/` extension 또는 별도 project pack으로 이동.
5. `PAVEDA_HOOK_PROFILE=standard`로 운영 시작.
6. `paveda doctor`로 host bundle, context modules, instruction file, model
   metadata, `/do` router, Codex skill metadata, hook 설정, project hook/check
   상태를 점검.
7. `paveda adoption-report --host ...`로 host surface, policy source, `/do` route gate를 한 번에 확인.
8. `paveda runtime-smoke` 또는 `adoption-report --runtime-smoke`로 EventStore write/replay path 확인.
9. 효과 측정 (cache hit rate, /do 평균 비용, ambiguity 게이트 통과율).

### Phase C — 다른 프로젝트로 확장 (옵션)

- 두 번째/세 번째 소비 프로젝트 채택.
- cross-project 글로벌 store(`~/.harness/store.db`)로 운영 메트릭 통합.

---

## 9. 설계 결정

### D1. 프로젝트 이름

후보:
- `harness` (단순, 검색성 약함)
- `claude-harness`
- `agent-harness`

결정: **paveda**. 이 repo의 패키지명과 GitHub repo명을 기준으로 한다.

### D2. 구현 언어

결정: **TypeScript**. 이유 — CLI, hook adapter, skill loader, package assets를
같은 런타임에서 운영할 수 있다. SQLite EventStore는 Node 내장 `node:sqlite`를 사용한다. 자세한
결정은 [`docs/decisions/0001-typescript-node-sqlite.md`](./decisions/0001-typescript-node-sqlite.md).

### D3. 제공 형태

결정: **JS package + CLI**. CLI는 `paveda` 명령을 제공하고, package assets에
host compatibility bundle을 포함한다. Host별 산출물은 installer가 생성한다.

### D4. repo 위치

결정: **public GitHub repo**에서 운영한다. 조직 이전이나 governance 변경이
필요해지면 별도 ADR로 다룬다.

### D5. 프로젝트 임시 상태 디렉토리 처리

- 프로젝트 도메인 hook이 자체 임시 상태를 가질 수 있다.
- Paveda EventStore는 하네스 운영 lineage만 책임진다.
- 프로젝트별 임시 상태는 project hook/check 소유로 유지한다.

---

## 10. 비기능 요구사항

### 10.1 성능 목표

| 메트릭 | 목표 |
|---|---|
| Hook dispatch 오버헤드 | < 50 ms / event (minimal profile에서) |
| EventStore append latency | < 5 ms |
| Skill 로딩 cold start | < 200 ms (10개 skill 기준) |
| Prompt cache hit rate | > 70% (정적 tool list 가정) |

### 10.2 의존성 최소화

- Node 내장 API 우선 (`node:sqlite`, `node:fs`, `node:path`, `node:child_process`).
- 외부 런타임 의존성은 명확한 필요가 있을 때만 추가한다.
- PAL Router는 model/provider 호출을 직접 수행하지 않고 routing decision과 lineage를 기록한다.

### 10.3 관찰성

- 모든 이벤트가 EventStore에 append → 디버깅 시 lineage 재구성 가능.
- `paveda status --exit-code`로 CI 통합.

### 10.4 보안

- API key는 환경변수만 (`.env` 직접 쓰기는 destructive.guard가 차단).
- 글로벌 store(`~/.harness/store.db`)는 권한 0600.

---

## 11. 관련 문서

- 모듈별 동작 요약: [`docs/architecture.md`](./architecture.md).
