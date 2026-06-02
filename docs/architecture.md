# paveda architecture

## 1. 책임 분리

| 영역 | 책임 | 변경 빈도 |
|---|---|---|
| 호스트 (Claude Code, Codex, pi, Hermes) | 본체 — paveda 변경 없음 | 외부 |
| **paveda (이 repo)** | policy runtime, host adapters, optional portable skills, hook profile, skill loader, SQLite EventStore, PAL Router, /specify ambiguity 게이트 | 중간 |
| 프로젝트 도메인 hook/skill | docs / wiki / deploy 같은 프로젝트별 정책 | 자주 |
| 외부 도메인 지식 저장소 | 도메인 지식 노드, 결정 기록 | 자주 |
| SQLite EventStore (paveda 내부) | 운영 lineage, 비용 추적, instinct (옵션) | 매 세션 |

## 2. 모듈

```
src/
├── core/             # 타입, 에러, 설정, 환경변수 로더
├── policy/           # AgentEvent, PolicyEngine, PolicyDecision, HostCapability, bundle
├── hook-runtime/     # profile gate, lifecycle dispatch
├── store/            # SQLite EventStore + query CLI
├── skill-loader/     # SKILL.md 파서, scope priority
├── router/           # PAL Router (Frugal→Standard→Frontier)
├── host-bundles/     # compatibility assets → host별 산출물 렌더링
├── init/             # host bootstrap + doctor orchestration
├── doctor/           # host bundle/readiness 점검
├── checks/           # project checks, runtime smoke, adoption report
└── adapters/
    ├── claude-code/  # Claude Code hook spec 매핑
    ├── codex/        # Codex hook spec 매핑
    ├── hermes/       # Hermes hook/plugin payload 매핑
    └── pi/           # Pi extension event 매핑

assets/
└── harness/          # Paveda compatibility skills, context modules, instructions
```

## 3. 추상 lifecycle 이벤트

Hook adapter는 host payload를 먼저 공통 `AgentEvent`로 정규화하고,
`PolicyEngine`은 기존 guard 결과를 `PolicyDecision`으로 변환한다. Hook runtime은
legacy guard evaluation event를 보존하면서 `policy_decisions` 테이블과
`policy.decision` event를 함께 기록한다.
세션 workflow state는 EventStore replay로 projection한다. 현재 구현은
`intake → specifying → planning → executing → verifying → handoff` phase와
plan-only mutation gate, root-cause evidence gate, verification-before-handoff
gate를 정책 decision으로 기록한다.
`doctor --enforcement`는 capability tier와 함께 synthetic `PolicyEngine` probe
결과를 반환해 action별 rule decision이 실제로 생성되는지 확인한다.

MCP gateway는 `paveda mcp serve`로 stdio JSON-RPC endpoint를 열고
`paveda.search/read/patch/shell/git/test` wrapper tool을 제공한다. Native host
tool이 열려 있으면 MCP는 완전한 security boundary가 아니지만, wrapper tool로
들어온 action은 동일한 `AgentEvent → PolicyEngine → EventStore → executor`
경로를 통과한다. `--policy-cache`를 전달하면 hook runtime과 같은 verified
bundle source metadata가 `PolicyEvaluation`과 `policy.decision` evidence에 남고,
cache 검증 실패 시 tool 실행 전에 실패한다.

Policy bundle은 같은 runtime rule version/fingerprint metadata와 host capability matrix를
deterministic JSON artifact로 export한다. `canonicalSha256` digest는 control
plane이 배포 전후 동일성을 확인하는 값이고, Ed25519 signature가 있으면 adapter나
운영 도구가 bundle drift를 감지할 수 있다. `policy pull`은 path, `file://`,
`http://`, `https://` source에서 signed bundle을 가져와 trusted keyring으로
검증하고, 검증된 artifact를 cache envelope으로 저장한다. Hook runtime은
`PAVEDA_POLICY_CACHE`가 설정된 경우 이 cache envelope을 읽어 `PolicyEvaluation`과
`policy.decision` evidence에 policy source metadata를 남긴다.
`doctor --enforcement --policy-cache`와 `adoption-report --policy-cache`는 같은
cache envelope을 읽어 운영자가 현재 host가 어느 bundle digest/key를 기준으로
평가 중인지 확인하게 한다. 이 check는 bundle의 rule metadata와 host capability
matrix를 로컬 runtime과 비교해 drift가 있으면 실패한다.

| 추상 이벤트 | Claude Code | Codex | Hermes | Pi |
|---|---|---|---|---|
| `session.created` | SessionStart | SessionStart | on_session_start | session_start |
| `prompt.submitted` | UserPromptSubmit | UserPromptSubmit | pre_llm_call / pre_gateway_dispatch | input / before_agent_start |
| `tool.execute.before` | PreToolUse | PreToolUse / PermissionRequest | pre_tool_call | tool_call |
| `tool.execute.after` | PostToolUse / PostToolUseFailure | PostToolUse | post_tool_call / transform_tool_result | tool_result / tool_execution_end |
| `session.completed` | Stop / SessionEnd | Stop | on_session_end | session_shutdown |

Host bundle installer는 별도 레이어로 `harness`, `claude-code`, `codex`, `pi`,
`hermes` compatibility 산출물을 생성한다.

## 4. Hook 프로파일

| 프로파일 | 활성 hook (기본) | 용도 |
|---|---|---|
| `minimal` | session.context (요약), destructive.guard | 빠른 응답, 저비용 |
| `standard` | 7개 전부 | 기본값 |
| `strict` | 7개 + verbose 로깅 + cost.guard 강화 | CI 직전 검증 |

내장 운영 hook 7개:
1. `harness.session.context` — SessionStart 컨텍스트 주입 (MAX_CHARS 상한)
2. `harness.cost.guard` — Agent 스폰/세션 시간 추적
3. `harness.test.process.cleanup` — test command 이후 남은 test worker process 정리
4. `harness.destructive.guard` — rm -rf, DROP TABLE, .env 쓰기 등 차단
5. `harness.blast.check` — package.json 등 manifest 변경 감지
6. `harness.tooling.enforce` — cat/grep/find/sed → Read/Grep/Glob/Edit 강제
7. `harness.worktree.port` — 결정론적 포트 할당

> 프로파일 변경은 세션 시작 시점에만 평가. 세션 중 동적 변경은 prompt cache 무효화 위험으로 금지.
> Hook runtime은 `config.snapshot` 이벤트를 EventStore에 기록하고, 같은 세션의
> 후속 hook에서는 이 값을 우선한다. 이 snapshot은 SessionStart context hook의
> 활성 여부와 분리되어 기록된다.

## 5. SQLite EventStore

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX idx_events_session ON events(session_id, ts);
CREATE INDEX idx_events_type ON events(type, ts);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cost_usd REAL DEFAULT 0,
  agent_spawns INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE router_decisions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  skill TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT,
  result TEXT
);

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

CREATE TABLE instincts (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  pattern TEXT NOT NULL,
  evidence TEXT,
  examples TEXT,
  confidence REAL NOT NULL,
  ttl_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

Store 위치:
- `~/.harness/store.db` — cross-project 글로벌 운영 메트릭
- `<project>/.harness/store.db` — 프로젝트 로컬 lineage

CLI는 기본적으로 project store를 사용한다. `--store-scope user`를 지정하면
user store를 사용하고, `--db <path>`는 두 scope보다 우선한다.

Store 파일은 owner-only 권한(0600)으로 보호한다. 현재 schema version은 `2`이며,
미래 버전으로 생성된 store는 데이터 손상을 피하기 위해 열지 않는다.

## 6. PAL Router (v0: `/do` 한정)

```
do 진입 → tier=frugal
  ├ 성공 → router_decisions(result=success), 다음 세션 frugal 유지
  └ 실패 신호 감지 → tier=standard
      ├ 성공 → 기록
      └ 실패 → tier=frontier, 마지막 시도
```

Escalation 트리거:
- Tool call 재시도 3회 초과
- `/verify` 실패 1회
- Ambiguity score 0.3 초과 재상승
- 작업 30분 초과 (옵션)

Downgrade: 연속 3개 do 세션 성공 시 1단계 다운그레이드.

## 7. SKILL.md 표준

Host-compatible `SKILL.md` frontmatter 형식 + paveda 확장 필드:

```yaml
---
name: do
description: ...
model: standard
allowed-tools: [...]
disable-model-invocation: false

# paveda 확장
router: enabled              # PAL Router 적용 (do만 true)
trigger:
  paths: [src/**/*.ts]
  keywords: [구현, 만들어]
ambiguity-required: 0.2      # /specify 점수 임계값
---
```

Scope priority: project override (`.harness/skills`, `.claude/skills`) > user override (`~/.harness/skills`) > Paveda canonical builtin (`assets/harness/skills`).

Paveda의 기본 동작은 project-local skill 존재 여부에 의존하지 않는다. Project-local paths are extension points used only when a consumer project intentionally overrides or augments the packaged harness.

Manifest skills can be marked `optional`. Default host bundle installs include only core workflow skills, while optional portable skills are installed through `--include-optional` or explicit `--skills`.

## 8. /specify ambiguity 게이트

```
ambiguity = 1 - (0.5 × goal_clarity + 0.3 × constraint_clarity + 0.2 × ontology_clarity)
```

`/do`는 진입 전 `ambiguity ≤ 0.2` 게이트 통과 필요. 초과 시 `/specify` 재진행 유도(블로킹).

## 9. EventStore ↔ 외부 도메인 지식 저장소 인터페이스

두 store는 **서로 모른 채** 동작. 연결은 외부 도구가 담당:

- `paveda export-decisions --skill do --since 7d` — router_decisions 중 의미 있는 것을 결정 후보로 export.
- 외부 reporting skill이 두 store를 함께 조회해 합성 보고서 작성.

Instinct records are EventStore-local operating patterns. They are managed with
`paveda instincts add`, `paveda instincts`, and `paveda instincts set-status`.

## 10. 관련 문서

- 전체 spec: [`docs/spec.md`](./spec.md)
