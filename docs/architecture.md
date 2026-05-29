# paveda architecture

## 1. 책임 분리

| 영역 | 책임 | 변경 빈도 |
|---|---|---|
| 호스트 (Claude Code, Codex, pi, Hermes) | 본체 — paveda 변경 없음 | 외부 |
| **paveda (이 repo)** | canonical harness bundle, optional portable skills, hook profile, skill loader, SQLite EventStore, PAL Router, /specify ambiguity 게이트 | 중간 |
| 프로젝트 도메인 hook/skill | docs / wiki / deploy 같은 프로젝트별 정책 | 자주 |
| 외부 도메인 지식 저장소 | 도메인 지식 노드, 결정 기록 | 자주 |
| SQLite EventStore (paveda 내부) | 운영 lineage, 비용 추적, instinct (옵션) | 매 세션 |

## 2. 모듈

```
src/
├── core/             # 타입, 에러, 설정, 환경변수 로더
├── hook-runtime/     # profile gate, lifecycle dispatch
├── store/            # SQLite EventStore + query CLI
├── skill-loader/     # SKILL.md 파서, scope priority
├── router/           # PAL Router (Frugal→Standard→Frontier)
├── host-bundles/     # canonical harness assets → host별 산출물 렌더링
├── init/             # host bootstrap + doctor orchestration
├── doctor/           # host bundle/readiness 점검
├── checks/           # project checks, runtime smoke, adoption report
└── adapters/
    └── claude-code/  # Claude Code hook spec 매핑

assets/
└── harness/          # Paveda canonical core skills, context modules, instructions
```

## 3. 추상 lifecycle 이벤트

| 추상 이벤트 | Claude Code 매핑 | 향후 host hook 매핑 |
|---|---|---|
| `session.created` | SessionStart | session_start |
| `tool.execute.before` | PreToolUse | tool_call_before |
| `tool.execute.after` | PostToolUse | tool_call_after |
| `session.completed` | Stop | session_end |

v0 hook runtime adapter는 Claude Code lifecycle payload를 지원한다. Host bundle
installer는 별도 레이어로 `harness`, `claude-code`, `codex`, `pi`, `hermes`
산출물을 생성한다.

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

Store 파일은 owner-only 권한(0600)으로 보호한다. 현재 schema version은 `1`이며,
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
