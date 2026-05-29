---
name: do
description: "Planner-Design Validator-Generator-Gap Detector-Iterator PDCA 멀티 에이전트 TDD 실행기. PM 연동(/specify --discover) → Plan → Design Validation → Sprint(Do → Check → Act) 전체 PDCA 사이클. /do로 모든 구현 작업을 시작."
argument-hint: "[--from-spec <path>] <task description>"
allowed-tools: Bash, Bash(node:*), Bash(git:*), Read, Write, Edit, Glob, Grep, AskUserQuestion, Skill, Agent
router: enabled
ambiguity-required: 0.2
---

# /do — PDCA Multi-Agent Task Executor

작업 설명을 받아 Plan → Design → Do → Check → Act 전체 PDCA 사이클을 실행한다.
PM 연동 → 계획 → 설계 검증 → (Sprint Loop: 구현 → Gap 분석 → 수정) → 커밋 제안까지 하나의 명령으로 처리.

공통 운영 규칙:
- 도메인 문서 로딩: `.harness/context-modules/`의 관련 module을 우선 사용한다.
- TDD 실행 계약: `references/test-rules.md`의 vertical slice TDD 원칙을 따른다.
- 버그/회귀 수정 진단 계약: `/debug`의 재현 루프 우선 원칙을 따른다.

## Architecture

```
사용자 프롬프트 → Orchestrator (이 스킬)
                      │
                      ├─ Phase 1: 인수 파싱
                      │
                      ├─ Phase 1.1: 세션 상태 초기화       ← Phase 1 직후 반드시 실행
                      │     ├─ .do-state/ 중단 세션 탐지 → 재개 여부 확인
                      │     └─ session-meta.json 즉시 생성  (resume_from: "phase_1.5")
                      │           → 이후 각 Phase 완료 시 resume_from 업데이트
                      │
                      ├─ Phase 1.5: Interview Gate          ← 기본 실행 시 항상 동작
                      │     └─ /specify 전체 인터뷰         (--from-spec, --ultraplan 시 건너뜀)
                      │           → SPEC_PATH 캡처
                      │           → IS_FROM_SPEC = true
                      │
                      ├─ Phase 2-3: 분석 + 컨텍스트 로드
                      │
                      ├─ Phase 4a: Planner Agent (sub-agent) → Product Spec
                      ├─ Phase 4b: Design Validator (sub-agent) → 설계 검증 + Spec 완성도 + PM 리스크
                      │                                         │
                      │                                   사용자 승인 (Spec 완성도 점수 포함)
                      │                                         │
                      ├─ Phase 5: Sprint Loop ◀─────────────────┘
                      │     .do-state/<session-id>/ 초기화
                      │     Phase 5-dep: PARALLEL_GROUPS 구성 (의존성 그래프 위상 정렬)
                      │     │
                      │     ├─ [병렬 그룹] Generator Agents 동시 스폰 → 전원 완료 대기
                      │     │   이후 각 Sprint별 5a-post ~ 5e 순차 진행
                      │     ├─ [순차 그룹] Generator Agent (sub-agent) → 구현 + Self-eval (Do)
                      │     ├─ Phase 5a-post: git diff vs Generator 보고 → CLAIM_GAP 탐지
                      │     │
                      │     ├─ Gap Detector (sub-agent) → Match Rate + Gap Analysis (Check)
                      │     │     Stage 0: Pre-scan + P2P Gate + Canary
                      │     │     PASS (≥90%) → 다음 Sprint
                      │     │     RETRY (70-89% 또는 Pre-scan FAIL) ↓
                      │     ├─ Iterator Agent (sub-agent) → 최소 수정 (Act)
                      │     │     → Gap Detector 재검증 (최대 3회, 연속 동일 실패 시 조기 중단)
                      │     │
                      │     ├─ Phase 5d: sprint-state.json 갱신 (Sprint PASS 후)
                      │     │
                      │     └─ Phase 5e: Review Gate (매 Sprint 완료 후)
                      │           ├─ 5e: review command → ISSUES 없음 → Phase 5e-2
                      │           ├─ 5e-1: ISSUES 있음 → Iterator → Gap Detector 재검증 1회
                      │           └─ 5e-2: Adversarial Test Generation (경계값/권한/동시성/대용량)
                      │
                      └─ Phase 6: Completion Report
                            ├─ Phase 6a: Completion Report
                            ├─ Phase 6b: Deferred Spec
                            └─ Phase 6c: Adversarial Review Gate
                                  ├─ codex:adversarial-review → 이슈 없음 → 종료
                                  ├─ CRITICAL → 사용자 판단 → 수정 or Deferred Spec 기록
                                  └─ WARN → Deferred Spec 기록 → 종료
```

## Usage

```
/do "add notification preferences page"                          # 기본: 인터뷰 → 구현 전체 파이프라인
/do --from-spec docs/specs/2026-03-23-xxx.md                     # 인터뷰+Planner 생략, 기존 스펙으로 Design Validator부터
/do --from-deferred docs/deferred/2026-04-24-xxx-deferred.md     # 인터뷰만 생략, Planner~Generator 전체 실행
/do docs/deferred/2026-04-24-xxx-deferred.md 내용 파악 후 진행   # 위와 동일 (자동 감지)
```

**인터뷰 건너뛰기**: `--from-spec` 또는 `--from-deferred` 플래그 사용 시 Interview Gate를 건너뛴다.

## First-Time Setup

새로운 레포지토리에서 `/do`를 처음 사용할 때는 Paveda host bundle을 먼저 설치한다:

```bash
# dry-run으로 생성될 host surface 확인
paveda init --host <host> --cwd /path/to/repo

# 확인 후 실제 파일 생성
paveda init --host <host> --cwd /path/to/repo --write

# 설치 후 readiness와 runtime path 확인
paveda adoption-report --host <host> --cwd /path/to/repo --runtime-smoke --json
```

초기화 명령은 다음 host surface를 생성하거나 점검한다:

| 파일 | 설명 |
|------|------|
| host skill root | `/do`, `/specify`, `/plan`, `/verify`, `/debug`, `/commit`, `/pr`, `/surgical-edits` |
| host context modules | backend/frontend/worker/infra context modules |
| host instruction file | 선택한 host가 읽는 Paveda harness instructions |
| `.harness/hooks` | 프로젝트 소유 hook extension point (명시 opt-in 전에는 실행하지 않음) |
| `.harness/checks` | 프로젝트 소유 executable check extension point |

lint/test/build 명령은 현재 레포지토리의 package manager metadata와 `package.json`
scripts를 기준으로 추론한다. 명령이 없으면 Completion Report에 `SKIP`으로 기록하고,
임의의 새 script나 설정 파일을 생성하지 않는다.

## Execution Order

### Phase 1: Parse Arguments

1. `$ARGUMENTS`에서 플래그 추출:
   - `--from-spec <path>`: 기존 스펙 파일 기반 구현 (Interview Gate + Planner 건너뜀)
   - `--from-deferred <path>`: deferred 파일 기반 구현 (Interview Gate만 건너뜀, Planner는 실행)
2. 나머지 텍스트 = TASK_DESCRIPTION
3. 텍스트 없으면 usage 안내 후 중단
4. **자동 감지**: 명시적 플래그가 없어도 TASK_DESCRIPTION에 `docs/deferred/` 경로가 포함되면
   → 해당 경로를 추출하여 IS_FROM_DEFERRED = true, IS_FROM_SPEC = false 설정
   → 파일을 Read하여 내용을 DEFERRED_CONTEXT 변수에 저장

### Phase 1.1: 세션 상태 초기화 (Checkpoint Gate)

**이 Phase는 Phase 1 직후, Phase 1.5 전에 반드시 실행한다.**

> **초기화 확인**: host skill root에 `/do`가 없거나 instruction/context modules가
> 누락된 레포지토리에서는 `paveda init --host <host> --cwd <repo>`와
> `paveda doctor --host <host> --cwd <repo>` 실행을 안내한다.

#### 1단계: 기존 중단 세션 탐지

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

# status=running이고 updated_at이 30분 이상 경과한 세션 탐색
INTERRUPTED_META=""
if [ -d "${PROJECT_ROOT}/.do-state" ]; then
  for meta in "${PROJECT_ROOT}/.do-state"/*/session-meta.json; do
    [ -f "$meta" ] || continue
    status=$(jq -r '.status // ""' "$meta" 2>/dev/null)
    updated=$(jq -r '.updated_at // ""' "$meta" 2>/dev/null)
    if [ "$status" = "running" ]; then
      # updated_at이 30분 이상 경과한 경우만
      updated_epoch=$(date -d "$updated" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$updated" +%s 2>/dev/null || echo 0)
      now_epoch=$(date +%s)
      age=$((now_epoch - updated_epoch))
      if [ "$age" -gt 1800 ]; then
        INTERRUPTED_META="$meta"
        break
      fi
    fi
  done
fi
```

중단 세션이 발견되면 AskUserQuestion으로 사용자에게 확인:
> "이전에 중단된 `/do` 세션이 있습니다.
> 작업: {session-meta.json의 task_description}
> 중단 위치: {resume_from}
> 재개하시겠습니까?"

- **YES** → 해당 meta 파일에서 변수 복원 후 `resume_from` 지점으로 점프:
  ```bash
  SESSION_ID=$(jq -r '.session_id' "$INTERRUPTED_META")
  STATE_DIR="${PROJECT_ROOT}/.do-state/${SESSION_ID}"
  META_FILE="${INTERRUPTED_META}"
  STATE_FILE="${STATE_DIR}/sprint-state.json"
  HISTORY_FILE="${STATE_DIR}/verification-history.jsonl"
  TASK_DESCRIPTION=$(jq -r '.task_description' "$META_FILE")
  IS_FROM_SPEC=$(jq -r '.is_from_spec' "$META_FILE")
  FROM_SPEC_PATH=$(jq -r '.from_spec_path // ""' "$META_FILE")
  SPEC_PATH=$(jq -r '.spec_path // ""' "$META_FILE")
  RESUME_FROM=$(jq -r '.resume_from' "$META_FILE")
  ```
  → RESUME_FROM 값에 따라 해당 Phase로 직접 이동 (아래 복원 맵 참조)
- **NO** → 새 SESSION_ID로 진행 (2단계로)

**복원 맵** (`resume_from` → 진입 Phase):

| resume_from | 진입 위치 | 필요 컨텍스트 |
|-------------|----------|---------------|
| `phase_1.5` | Phase 1.5 처음 | TASK_DESCRIPTION |
| `phase_1.6` | Phase 1.6 처음 | FROM_SPEC_PATH 또는 SPEC_PATH (Phase 1 또는 4d에서 설정됨) |
| `phase_2` | Phase 2 처음 | TASK_DESCRIPTION, IS_FROM_SPEC, FROM_SPEC_PATH |
| `phase_3` | Phase 3 처음 | TASK_DESCRIPTION + AFFECTED_FILES (Phase 2 재실행) |
| `phase_4a` | Phase 4a 처음 | TASK_DESCRIPTION + Phase 2 재실행 + reference context 재구성 |
| `phase_4b` | Phase 4b 처음 | spec_path에서 PRODUCT_SPEC 로드 |
| `phase_4c` | Phase 4c 처음 | spec_path에서 PRODUCT_SPEC 로드 |
| `phase_4d` | Phase 4d 처음 | spec_path에서 PRODUCT_SPEC 로드 |
| `phase_5_pre` | Phase 5-pre | spec_path에서 PRODUCT_SPEC 로드 |
| `phase_5a` 이상 | Phase 5-pre → Sprint Loop | 기존 Sprint Loop 재개 로직 |

> **phase_3/4a 복원**: AFFECTED_FILES와 KNOWLEDGE_CONTEXT는 직렬화하지 않는다. 복원 시 Phase 2/3을 빠르게 재실행하여 컨텍스트를 재구성한다. `spec_path`가 있으면 Impact Analysis 대상이 명확하므로 재실행 비용이 낮다.

#### 2단계: 신규 세션 초기화

중단 세션이 없거나 사용자가 새 세션을 선택한 경우:

```bash
SESSION_ID=$(date +%Y%m%d-%H%M%S)
STATE_DIR="${PROJECT_ROOT}/.do-state/${SESSION_ID}"
META_FILE="${STATE_DIR}/session-meta.json"
STATE_FILE="${STATE_DIR}/sprint-state.json"
HISTORY_FILE="${STATE_DIR}/verification-history.jsonl"

mkdir -p "${STATE_DIR}"
```

`session-meta.json`을 Write 도구로 즉시 생성:

```json
{
  "session_id": "{SESSION_ID}",
  "task_description": "{TASK_DESCRIPTION}",
  "is_from_spec": false,
  "from_spec_path": "",
  "spec_path": "",
  "started_at": "{ISO8601 현재 시각}",
  "updated_at": "{ISO8601 현재 시각}",
  "status": "running",
  "last_sprint": 0,
  "resume_from": "phase_1.5"
}
```

`--from-spec` 사용 시: `is_from_spec: true`, `from_spec_path: "{경로}"`, `resume_from: "phase_1.6"` 로 설정 — Phase 1.5(Interview Gate)는 스킵되지만 Phase 1.6(Ambiguity Score 게이트)는 반드시 통과해야 한다.

> **이 파일이 생성된 시점부터 세션 재개가 가능하다.** 이후 각 Phase는 전환 완료 시점에 `resume_from`과 `updated_at`을 업데이트한다.

### Phase 1.5: Interview Gate

다음 조건에 해당하면 이 Phase를 **건너뛴다**:
- `IS_FROM_SPEC = true` (`--from-spec` 플래그 사용)
- `IS_FROM_DEFERRED = true` (`--from-deferred` 플래그 또는 자동 감지)

> **건너뛸 때 다음 행선지**: Phase 1.5를 스킵해도 **Phase 1.6(Ambiguity Score 게이트)는 반드시 통과**해야 한다. Phase 2로 직행하지 마라.

**절대 건너뛰지 않는다** (Orchestrator 자체 판단 금지):
- TASK_DESCRIPTION에 파일 경로가 포함된 경우 (IS_FROM_DEFERRED 자동 활성화로 처리할 것)
- 파일 내용을 Read했고 상세 구현 계획이 있는 경우
- 위 명시 조건 외 어떤 이유로도 Orchestrator가 자체 판단으로 이 Phase를 건너뛰지 않는다

그 외 모든 경우 (기본 실행):

1. Skill tool로 `/specify "{TASK_DESCRIPTION}"` 호출 (전체 Socratic 인터뷰)
2. `/specify` 출력에서 `SPEC_PATH:` 접두사 라인을 파싱하여 경로 추출:
   ```
   FROM_SPEC_PATH = /specify 출력의 "SPEC_PATH: " 이후 텍스트
   ```
3. `IS_FROM_SPEC = true` 설정 → 이후 Phase 4a/4b/4c/4d가 `--from-spec` 모드로 동작
4. **체크포인트 업데이트** (`.tmp → rename`):
   ```bash
   jq ".from_spec_path = \"${FROM_SPEC_PATH}\" | .is_from_spec = true | .resume_from = \"phase_1.6\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
   ```
5. Phase 1.6으로 진행 (Ambiguity Score 게이트)

> **인터뷰 중단 처리**: 사용자가 인터뷰 중 "건너뛰기", "스킵", "그냥 진행" 등의 신호를 주면
> `/specify`의 seed-closer 로직이 즉시 종료하고 현재까지 수집된 정보로 최소 스펙을 생성한다.
> `SPEC_PATH:` 라인은 항상 출력되므로 Interview Gate의 경로 파싱은 정상 동작한다.

### Phase 1.6: Ambiguity Score 게이트

Phase 1.5/1 직후 시점의 spec 경로는 `FROM_SPEC_PATH`에 있음. Phase 4d 이후에는 `SPEC_PATH`도 동일 값으로 설정됨. frontmatter를 추출하여 `ambiguity_score`를 Read한다.

```bash
# frontmatter 영역(첫 30줄)에서 ambiguity_score 추출
SPEC_FILE="${FROM_SPEC_PATH:-${SPEC_PATH}}"
AMBIGUITY_SCORE=$(test -n "$SPEC_FILE" && head -30 "$SPEC_FILE" 2>/dev/null | grep "^ambiguity_score:" | head -1 | awk '{print $2}' | tr -d '"' || true)
# 음수·비숫자 값은 0.0 fallback으로 강제 (방어적 검증); 범위 초과(>1.0)도 fallback
[[ "$AMBIGUITY_SCORE" =~ ^[0-9]+(\.[0-9]+)?$ ]] || AMBIGUITY_SCORE=""
(( $(echo "${AMBIGUITY_SCORE:-0} > 1.0" | bc -l 2>/dev/null) )) && AMBIGUITY_SCORE=""
```

처리 규칙:
- **유효 범위: 0.0 ≤ score ≤ 1.0 — 범위 밖이거나 비숫자(음수 포함)는 0.0 fallback으로 강제**
- **필드 누락** (grep 결과 없음 → AMBIGUITY_SCORE 비어있음) → `0.0`으로 간주 (0.0 fallback, 하위 호환)
- **값이 ≤ 0.2** → 통과, Phase 2로 진입
- **값이 > 0.2** → `AskUserQuestion`으로 사용자에게 다음을 표시:

  > "spec의 ambiguity_score가 {값}로 권장 임계 0.2를 초과합니다.
  > 가장 낮은 clarity 차원: {clarity_dimensions 중 최솟값 차원}
  > 옵션: (1) 그대로 진행, (2) /specify로 돌아가 재인터뷰"

  - (1) 그대로 진행 → Phase 2로 진입
  - (2) /do 종료 후 사용자에게 `/specify` 재실행 안내

**Phase 1.6 게이트 통과 후 체크포인트 업데이트** (`.tmp → rename`):
```bash
# Phase 1.6 게이트 통과 후 체크포인트 업데이트
jq ".resume_from = \"phase_2\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

> **spec 미존재 경로**: `--from-spec` / `--from-deferred` 미사용 시 Phase 1.5에서 `/specify`가 항상 spec을 생성하고 SPEC_PATH를 반환하므로, Phase 1.6 진입 시점에 spec이 없는 경우는 발생하지 않는다.

### Phase 2: Impact Analysis

영향 받는 파일과 기존 테스트를 식별한다:

1. TASK_DESCRIPTION에서 키워드 추출 (도메인명, 기능명, 컴포넌트명)
2. 현재 repo의 실제 top-level 구조를 먼저 확인한다 (`src/`, `app/`, `apps/`,
   `packages/`, `lib/`, `server/`, `client/`, `web/`, `api/`, `workers/`,
   `services/`, `components/`, `routes/` 등 존재하는 경로만 사용).
3. Grep/Glob으로 TASK_DESCRIPTION 키워드와 관련된 코드, 설정, 테스트, 문서를 검색한다.
4. `--from-spec` 사용 시: 스펙 파일의 Tasks 섹션에서 파일 목록 추출
5. 결과를 AFFECTED_FILES 목록으로 정리
6. **AFFECTED_TESTS 식별**: AFFECTED_FILES와 연관된 기존 테스트 파일을 Glob으로 매칭
   - 패턴: `**/*.test.*`, `**/*.spec.*`, `tests/**/*`, 언어별 test 디렉터리
   - AFFECTED_FILES의 모듈명/파일명으로 테스트 파일 검색
7. **체크포인트 업데이트**:
   ```bash
   jq ".resume_from = \"phase_3\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
   ```

### Phase 2b: 코드베이스 컨텍스트 보강 (조건부)

**Phase 2b/2c 실행 결정표:**

| AFFECTED_FILES 수 | 도메인 판정 | 실행 |
|---|---|---|
| < 9 | 기존 도메인 | 건너뜀 → Phase 3 직행 |
| < 9 | 새 도메인¹ | **Phase 2b** |
| 9 ~ 14 | 무관 | **Phase 2b** |
| ≥ 15 | 무관 | **Phase 2c** (Codebase Scout, 2b 건너뜀) |

¹ 새 도메인 판정: 관련 타입, route/handler, service/use-case, UI entry, worker,
또는 기존 테스트가 현재 repo에서 발견되지 않는 경우. 특정 파일명에 의존하지 않는다.

이 단계는 별도 외부 bridge 없이 현재 agent의 Read/Grep/Glob/Bash 도구만 사용한다.
AFFECTED_FILES의 상위 디렉토리에서 import 관계, 네이밍, 타입 흐름, 제약을 직접
확인하여 구조화된 컨텍스트를 만든다.

**실행:**

1. AFFECTED_FILES에서 고유 상위 디렉토리를 추출한다.
2. Grep으로 각 파일의 import/export 사용처와 직접 호출자를 찾는다.
3. Read로 핵심 파일을 확인하여 아래 섹션을 채운다:
   - `ADDITIONAL_AFFECTED_FILES`: 누락된 간접 영향 파일
   - `PATTERNS`: 기존 네이밍 컨벤션과 구조 패턴
   - `TYPE_FLOW`: storage/model → domain/service → interface/API/UI/worker 흐름
   - `CONSTRAINTS`: 기존 coupling, 권한, 데이터, 런타임 제약
4. 결과를 `CODEBASE_CONTEXT`에 저장한다. 추가 파일이 발견되면 AFFECTED_FILES에 병합한다.

### Phase 2c: Codebase Scout (조건부)

**트리거 조건**: `AFFECTED_FILES >= 15`

Phase 2b 대신 실행한다. 광역 코드베이스 탐색과 핵심 파일 실측을 결합한 심층 분석으로
Planner가 즉시 설계에 착수할 수 있는 구조화된 CODEBASE_MAP을 생성한다.

`agents/codebase-scout.md`를 Read하여 프롬프트로 사용.

**Codebase Scout 서브 에이전트 호출** (mode: auto):

```
입력 변수:
- TASK_DESCRIPTION: {사용자 작업 설명}
- AFFECTED_FILES: {Phase 2 결과}
- PROJECT_ROOT: {프로젝트 루트 경로}
```

Scout 완료 후:
- 반환된 CODEBASE_MAP → `CODEBASE_CONTEXT`에 할당 (이후 Phase들이 동일하게 참조)
- CODEBASE_MAP의 `ADDITIONAL_AFFECTED_FILES` → AFFECTED_FILES에 병합

### Phase 3: Reference Context 로드

AFFECTED_FILES와 TASK_DESCRIPTION을 기반으로 packaged context modules와 실제
코드베이스 패턴을 로드한다. 외부 지식 저장소나 MCP 도구를 전제하지 않는다.

**Context module 선택:**

AFFECTED_FILES 경로 패턴에 따라 `.harness/context-modules/` 파일을 직접 Read:

| 파일 경로 패턴 | 폴백 모듈 |
|---------------|----------|
| `server/`, `api/`, `routes/`, `handlers/`, `services/`, `db/`, `models/`, `rpc/` | `.harness/context-modules/backend-patterns.md` |
| `client/`, `web/`, `app/`, `pages/`, `components/`, `ui/`, `views/` | `.harness/context-modules/frontend-patterns.md` |
| `worker/`, `workers/`, `jobs/`, `queues/`, `consumers/`, `processors/` | `.harness/context-modules/worker-patterns.md` |
| `docker/`, `.github/`, `deploy/`, `infra/`, `ops/`, `k8s/`, `terraform/` | `.harness/context-modules/infra-patterns.md` |

**새 도메인 시 로컬 패턴 합성 (조건부):**

새 도메인이거나 `AFFECTED_FILES >= 9`이면, context-modules Read 이후
Read/Grep/Glob으로 실제 코드베이스의 기존 패턴을 직접 합성한다.

정리할 항목:
1. entrypoint → domain/service → storage/integration 계층 구조 패턴 (실제 파일명/함수명 포함)
2. 타입/스키마/계약 정의 관례 (현재 repo의 위치 기준)
3. 에러 처리 패턴
4. 이 도메인에서 이미 확립된 네이밍 컨벤션

- 성공 시 → `KNOWLEDGE_CONTEXT`에 합성 내용을 append하여 Planner/Design Validator에 전달
- 실패 시 → context-modules Read 결과만 사용

**추가 조건:**
- UI route/page/component 파일을 **새로 생성**할 때 → Skill tool로 `optional frontend best-practices skill` 로드

**체크포인트 업데이트** (Phase 3 완료 시):
```bash
jq ".resume_from = \"phase_4a\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

### Phase 3b: 외부 리서치 (조건부)

**트리거 조건** (하나라도 해당 시 실행):
- TASK_DESCRIPTION에 외부 라이브러리/API/서비스 이름이 포함됨 (예: "Stripe", "OpenAI", "Slack", "S3", "Redis" 등 프로젝트 외부 서비스)
- `KNOWLEDGE_CONTEXT`가 비어 있거나 context module만으로 판단이 부족함
- AFFECTED_FILES에 `packages/` 신규 패키지 추가가 포함됨

**Phase 3b-1: 설치형 스킬 선조사 (`/find-skills`)**

직접 구현하기 전에 host에 사용 가능한 설치형 스킬이 있는지 확인한다.

Skill tool로 `/find-skills "{TASK_DESCRIPTION의 핵심 외부 기술 키워드}"` 호출을 시도한다. 스킬이 없거나 호출이 실패하면 이 단계를 건너뛰고 3b-2로 진행한다.

- 관련 스킬이 발견되면 (installs ≥ 1,000 기준) → SKILL_CANDIDATES로 저장 후 AskUserQuestion으로 사용자에게 선택지 제시:
  - "설치된 스킬 사용" → 설치 명령 실행 후 해당 스킬 기반으로 Sprint 계획 조정
  - "직접 구현" → Phase 3b-2로 진행
- 관련 스킬이 없으면 → Phase 3b-2로 진행

**Phase 3b-2: Web 리서치 (`/deep-research`)**

Skill tool로 `/deep-research "{TASK_DESCRIPTION}의 핵심 외부 기술/라이브러리 공식 문서, 통합 패턴, 주요 이슈"` 호출을 시도한다. 스킬이 없거나 호출이 실패하면 `RESEARCH_CONTEXT`를 비워 두고 packaged context + codebase synthesis만으로 계속 진행한다.

결과를 RESEARCH_CONTEXT로 저장 → Phase 4a Planner prompt에 포함:

```
### RESEARCH_CONTEXT
{deep-research 결과 요약 — TL;DR 섹션 + 실무자 인사이트만 발췌}

### SKILL_CANDIDATES (Phase 3b-1에서 수집된 경우)
{find-skills 결과 — 미설치 스킬이라도 Planner 입력으로 포함}
```

트리거 조건 미해당 시 이 Phase 전체를 건너뛴다.

### Phase 4a: Planner Agent

PM_CONTEXT는 Phase 1.5 Interview Gate에서 캡처한 스펙 파일의 PM 섹션을 사용한다.
`--from-spec` 경유(직접 또는 Interview Gate) 시: 스펙 파일을 Read하여 `### 문제 정의` 섹션을 PM_CONTEXT로 로드.
`IS_FROM_DEFERRED = true` 시: DEFERRED_CONTEXT 전체를 PM_CONTEXT에 포함 (deferred 항목 목록, 제외 이유, 해결 방향이 Planner의 Sprint 계획 기반이 됨).
스펙 파일도 deferred 파일도 없으면 PM_CONTEXT = 빈 값.

`agents/planner.md`를 Read하여 프롬프트로 사용.

**Planner 서브 에이전트 호출** (effort: xhigh, mode: auto):

```
입력 변수 (prompt으로 전달):
- TASK_DESCRIPTION: {사용자 작업 설명}
- AFFECTED_FILES: {Phase 2 + 2b 결과}
- AFFECTED_TESTS: {Phase 2 결과}
- CONTEXT_MODULES: {Phase 3에서 로드한 내용}
- KNOWLEDGE_CONTEXT: {Phase 3 reference context 결과 또는 빈 값}
- RESEARCH_CONTEXT: {Phase 3b deep-research + find-skills 결과 또는 빈 값}
- PM_CONTEXT: {스펙 파일의 문제 정의 섹션 또는 DEFERRED_CONTEXT 또는 빈 값}
- PROJECT_ROOT: {프로젝트 루트 경로}
- CODEBASE_CONTEXT: {Phase 2b/2c 코드베이스 분석 결과 또는 빈 값}
```

Planner는 `templates/product-spec.md` 구조를 따르는 Product Spec을 반환한다.

**체크포인트 업데이트** (Planner 완료 후):
```bash
jq ".resume_from = \"phase_4b\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

### Phase 4b: Design Validator

`agents/design-validator.md`를 Read하여 프롬프트로 사용.

**Design Validator 서브 에이전트 호출** (effort: xhigh, mode: auto):

```
입력 변수:
- PRODUCT_SPEC: {Planner 출력}
- CONTEXT_MODULES: {Phase 3에서 로드한 내용}
- KNOWLEDGE_CONTEXT: {Phase 3 reference context 결과 또는 빈 값}
- PM_CONTEXT: {PM 섹션 또는 빈 값}
- AFFECTED_FILES: {Phase 2 결과}
- HAS_UI_CHANGES: {UI route/page/component 변경 포함 여부}
- PROJECT_ROOT: {프로젝트 루트 경로}
```

Design Validator는 설계 검증 결과 + 수정된 PRODUCT_SPEC을 반환한다.
WARN 항목의 수정 제안이 반영된 PRODUCT_SPEC을 DESIGN_VALIDATION과 함께 저장한다.

**체크포인트 업데이트** (Design Validator 완료 후):
```bash
jq ".resume_from = \"phase_4c\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

### Phase 4c: 사용자 승인 게이트

- AskUserQuestion으로 Product Spec + Design Validation + Spec 완성도 점수를 표시하며 확인 요청. 승인 시 Phase 4d로 진행.
- `--from-spec` → 스펙 파일을 Read하여 PRODUCT_SPEC으로 사용, Phase 4b Design Validator 실행 후 Phase 4d로 진행.

**체크포인트 업데이트** (사용자 승인 직후):
```bash
jq ".resume_from = \"phase_4d\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

### Phase 4d: Product Spec 파일 저장

**구현 시작 전에 반드시 파일을 저장한다.** 세션 중단, sub-agent 참조, 이력 추적을 위해 필수.

#### 문서 관리 원칙

- **`docs/plans/` 파일은 불변(Immutable)**: 한 번 생성된 파일은 절대 수정하지 않는다.
- **충돌 시 신규 생성**: 같은 이름의 파일이 이미 존재하면 덮어쓰지 않고 접미사를 붙여 새 파일을 만든다.
- **`docs/INDEX.md`는 Append-only**: 기존 행을 수정하지 않고 항상 새 행을 추가한다.
  > **유일한 예외**: Phase 6a 완료 시 해당 plan의 `IN_PROGRESS` → `done` 상태 전환을 위해 해당 행만 sed로 수정한다.

#### 일반 실행 (`--from-spec` 없음)

1. 파일명 결정: `docs/plans/{YYYY-MM-DD}-{task-kebab}.md`
2. 동일 파일명이 이미 존재하면 `-v2`, `-v3` ... 접미사를 붙여 충돌 없는 이름 확정
3. Product Spec 전체 내용을 Write로 **신규 생성**
4. `PLAN_FILE` 변수에 확정된 파일 경로 저장 (예: `PLAN_FILE="docs/plans/2026-...-task-name.md"`)
   `SPEC_PATH` 변수도 동일 값으로 설정 (session-meta.json 체크포인트 호환)
5. `docs/INDEX.md`에 새 행 추가 (status: IN_PROGRESS) — 기존 행 수정 금지

#### `--from-spec` 실행

기존 Plan 파일을 재사용하는 실행이다. Plan 파일은 수정하지 않고, **실행 로그를 별도 파일로 생성**한다.

1. 실행 로그 파일명: `docs/plans/{YYYY-MM-DD}-{task-kebab}-run.md`
   - 동일 이름 존재 시: `-run-v2`, `-run-v3` ... 접미사 부여
2. 아래 내용으로 신규 생성:
   ```markdown
   ---
   title: "{TASK_DESCRIPTION} — 재실행"
   date: {YYYY-MM-DD}
   category: plans
   status: IN_PROGRESS
   source-spec: {--from-spec로 지정된 파일 경로}
   ---

   # {TASK_DESCRIPTION} — 재실행

   > 원본 스펙: {source-spec}
   > 이 파일은 기존 스펙 기반 재실행의 실행 로그다.

   ## 재실행 컨텍스트

   재실행 이유 또는 변경 사항을 여기에 기록한다 (없으면 생략).
   ```
3. `PLAN_FILE` 변수에 확정된 실행 로그 파일 경로 저장 (예: `PLAN_FILE="docs/plans/2026-...-task-name-run.md"`)
   `SPEC_PATH` 변수도 동일 값으로 설정 (session-meta.json 체크포인트 호환)
4. `docs/INDEX.md`에 새 행 추가 (status: IN_PROGRESS, source-spec 경로 포함) — 기존 행 수정 금지

**체크포인트 업데이트** (스펙 파일 저장 직후, `SPEC_PATH`가 확정된 뒤):
```bash
jq ".spec_path = \"${SPEC_PATH}\" | .resume_from = \"phase_5_pre\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

### Phase 5: Sprint Loop

Phase 5의 구현 단위는 `references/test-rules.md`의 vertical slice TDD를 따른다. Generator는 테스트를 대량으로 먼저 작성한 뒤 구현을 몰아서 처리하지 않는다. 각 Sprint 안에서도 하나의 behavior를 RED로 증명하고, 최소 GREEN 구현 후 다음 behavior로 이동한다. 버그 수정 Sprint는 `/debug`의 재현 루프 우선 원칙에 따라 원래 증상을 재현하는 feedback loop를 먼저 확보한다.

#### Phase 5-pre: Sprint Loop 초기화

**Sprint Loop 진입 전 초기화:**

컨텍스트에는 경로 참조만 유지한다. 배열 데이터(P2P_SUITE = [...])는 컨텍스트에 적재하지 않는다.

> **SESSION_ID, STATE_DIR, META_FILE, STATE_FILE, HISTORY_FILE 변수는 Phase 1.1에서 이미 설정됨.** 중단 세션 탐지도 Phase 1.1에서 완료됨. 여기서는 Sprint 전용 파일만 초기화한다.

아래 2개 파일을 Write 도구로 생성:

**sprint-state.json** (초기값):
```json
{
  "task_description": "{TASK_DESCRIPTION}",
  "current_sprint": 0,
  "total_sprints": {총 Sprint 수},
  "p2p_suite": [],
  "canary_suite": [],
  "updated_at": "{ISO8601 현재 시각}"
}
```

**verification-history.jsonl** (빈 파일)

**session-meta.json** (초기값):
```json
{
  "session_id": "{SESSION_ID}",
  "task_description": "{TASK_DESCRIPTION}",
  "spec_path": "{PRODUCT_SPEC 파일 경로}",
  "started_at": "{ISO8601 현재 시각}",
  "updated_at": "{ISO8601 현재 시각}",
  "status": "running",
  "last_sprint": 0,
  "resume_from": "phase_5a"
}
```

> **상태 파일 쓰기 규약**: sprint-state.json, session-meta.json 업데이트 시 반드시 `.tmp` 임시 파일에 쓴 후 rename(mv)으로 교체한다. POSIX rename은 원자적이므로 write 중 프로세스 종료 시에도 이전 파일이 보존된다.
> verification-history.jsonl은 append(`>>`)만 사용한다.

#### Phase 5-dep: Sprint 의존성 그래프 분석

PRODUCT_SPEC의 Sprint `parallel` / `depends_on` 선언을 파싱하여 병렬 실행 그룹(PARALLEL_GROUPS)을 구성한다.

**파싱 규칙:**
- `parallel: true` + `depends_on: []` → 의존성 없음, 즉시 실행 가능
- `depends_on: [N]` → Sprint N 완료 후 실행
- 두 필드 모두 없음 → 이전 Sprint에 순차 의존 (기존 동작과 동일)

**PARALLEL_GROUPS 생성 (위상 정렬):**
1. 의존 관계를 DAG(방향 비순환 그래프)로 구성
2. 의존성 없는 Sprint들 → Group 0
3. Group 0에만 의존하는 Sprint들 → Group 1, 이후 동일 방식으로 진행

**병렬 실행 전 파일 충돌 검사:**
같은 Group에 Sprint 2개 이상이 있으면, 각 Sprint SPEC의 Tasks에서 수정 파일 목록을 추출하여 교집합을 확인한다.
파일이 겹치는 Sprint 쌍은 해당 Group에서 분리하여 별도 순차 Group으로 처리한다.

**폴백:** `parallel` 필드가 없거나 모든 Sprint가 순차 의존이면 → PARALLEL_GROUPS = [[Sprint 1], [Sprint 2], ...] (하위 호환).

PARALLEL_GROUPS의 각 Group을 순서대로 처리한다.

**Group 내 Sprint가 1개 (순차 실행):**

해당 Sprint에 대해 Phase 5a → 5a-post → 5b → 5c → 5d → 5e를 기존 방식으로 실행한다.

**Group 내 Sprint가 2개 이상 (병렬 Generator, 순차 검증):**

1. `agents/generator.md`를 Read하여 GENERATOR_PROMPT로 로드 (1회만, 공유)
2. **Phase 5a-parallel: Generator 일괄 스폰** — 그룹 내 모든 Sprint에 대해 Generator 서브 에이전트를 **단일 응답에서 동시에** 스폰한다. 각 Generator에 해당 SPRINT_SPEC을 전달하고 전원 완료를 대기한다.
   > 병렬 실행 보장: Agent 호출을 같은 응답 내 복수 tool_use 블록으로 발행한다.
3. 전원 완료 후 → 각 Sprint에 대해 **Sprint 번호 순으로** Phase 5a-post → 5b → 5c → 5d → 5e 순차 실행.
   한 Sprint가 FAIL이면 나머지 Sprint 검증을 중단하고 사용자에게 판단을 위임한다.

각 Sprint에 대해 (순차 실행 그룹, 또는 병렬 그룹 내 순차 검증):

#### Phase 5a: Generator Agent 호출

`agents/generator.md`를 Read하여 프롬프트로 사용 (병렬 그룹에서 이미 로드된 경우 재사용).

**Generator 서브 에이전트 호출** (effort: xhigh, mode: auto):

> **프롬프트 구성 순서**: 장문 데이터(SPRINT_SPEC, CONTEXT_MODULES)를 prompt 최상단에 배치하고, generator.md 지시문은 최하단에 둔다.

```
입력 변수 (prompt 내 순서 준수):
1. SPRINT_SPEC: {PRODUCT_SPEC에서 해당 Sprint 섹션}           ← 최상단 (가장 큰 컨텍스트)
2. CONTEXT_MODULES: {Phase 3에서 로드한 내용}
3. ACCEPTANCE_CRITERIA: {PRODUCT_SPEC의 완료 기준 중 이 Sprint 해당분}
4. AFFECTED_TESTS: {Phase 2 결과}
5. PROJECT_ROOT: {프로젝트 루트 경로}
6. EVALUATOR_FEEDBACK: {재시도 시 Evaluator 피드백, 첫 시도는 빈 값}
```

Generator는 TDD로 구현 후 Self-evaluation을 통과한 결과를 반환한다.

#### Phase 5a-history: Generator 정체 감지용 history append (D4)

Generator 종료 직후 Orchestrator가 즉시 실행한다. git diff HEAD를 정규화 hash로 변환하여 generator-history.jsonl에 append한다.

```bash
# Generator 정체 감지 (D4) — history append
GENERATOR_HISTORY_FILE="${PROJECT_ROOT}/.do-state/${SESSION_ID}/generator-history.jsonl"
[ -f "$GENERATOR_HISTORY_FILE" ] || touch "$GENERATOR_HISTORY_FILE"
GEN_TRACKED_DIFF=$(git diff HEAD)
GEN_UNTRACKED_LIST=$(git ls-files --others --exclude-standard | sort)
GEN_UNTRACKED_DIGEST=""
if [ -n "$GEN_UNTRACKED_LIST" ]; then
  while IFS= read -r ut_file; do
    [ -f "$ut_file" ] || continue
    ut_hash=$(sha256sum -- "$ut_file" 2>/dev/null | awk '{print $1}')
    GEN_UNTRACKED_DIGEST="${GEN_UNTRACKED_DIGEST}${ut_file}:${ut_hash}"$'\n'
  done <<< "$GEN_UNTRACKED_LIST"
fi
GEN_HASH=$(printf '%s\n--untracked--\n%s' "$GEN_TRACKED_DIFF" "$GEN_UNTRACKED_DIGEST" | awk '{$1=$1;print}' | tr -s ' ' | grep -v '^$' | sha256sum | awk '{print $1}')
GEN_ITERATION_NUM=$((${GEN_ITERATION_NUM:-0} + 1))
GEN_SELFEVAL_STATUS="..."  # Generator 출력의 Self-Evaluation 표에서 파싱 (PASS/FAIL)
GEN_FINGERPRINT="..."      # 실패한 self-eval 항목 목록 (lint/test/build/스코프/Slop)

jq -n \
  --argjson sprint "$CURRENT_SPRINT" \
  --argjson iteration "$GEN_ITERATION_NUM" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg hash "$GEN_HASH" \
  --arg status "$GEN_SELFEVAL_STATUS" \
  --arg fp "$GEN_FINGERPRINT" \
  '{sprint:$sprint, iteration:$iteration, timestamp:$ts, output_hash_normalized:$hash, selfeval_status:$status, gap_fingerprint:$fp}' \
  >> "$GENERATOR_HISTORY_FILE"
```

#### Phase 5a-retry: Generator 정체 감지 및 재호출 (D4)

Generator Self-eval FAIL 시 Orchestrator가 GEN_RETRY_COUNT를 관리하여 정체 패턴을 감지하고 Generator 전용 페르소나를 주입한다.

**Sprint 진입 시 초기화:**

```
GEN_RETRY_COUNT = 0
GEN_ITERATION_NUM = 0
```

**Generator Self-eval 실패 시 retry 의사코드** (EVALUATOR_FEEDBACK는 immutable SPRINT_SPEC과 달리 retry 변수):

```
0. Generator 출력의 Self-Evaluation 표 파싱 — lint/test/build/스코프/Slop 중 하나라도 FAIL이면 retry 진입

1. GEN_RETRY_COUNT += 1
   if GEN_RETRY_COUNT > 4:
     → "Generator 최대 retry 4회(3 일반 + 1 페르소나 시도) 초과" + Self-eval 실패 내용을 사용자에게 보고하고 판단 위임 (loop 종료)

2. Phase 5a-history 블록 실행 (generator-history.jsonl append — 이미 위에서 정의된 블록)

3. detect-stagnation.sh 호출 및 Spinning/Oscillation 필터:
   STAG=$(bash "${PROJECT_ROOT}/.harness/skills/do/scripts/detect-stagnation.sh" \
     "$GENERATOR_HISTORY_FILE" --current-sprint "$CURRENT_SPRINT")
   FILTERED=$(echo "$STAG" | jq -c '.patterns | map(select(. == "Spinning" or . == "Oscillation"))')

4. FILTERED가 비어있지 않으면 페르소나 prepend 후 재호출:
   - Spinning 감지 → tdd-purist (Red Phase 재작성)
   - Oscillation 감지 → refactorer (구조 재설계)
   - 두 패턴 동시 감지 → tdd-purist + refactorer union (추가 fallback 없음)
   - 페르소나 MD를 Read하여 EVALUATOR_FEEDBACK 앞에 prepend (구분선 ---)

5. EVALUATOR_FEEDBACK_AUGMENTED 구성:
   # 패턴 → 페르소나 파일명 매핑 (Generator 전용)
   FILTERED_PERSONAS=$(echo "$FILTERED" | jq -r '
     map(
       if . == "Spinning" then "tdd-purist"
       elif . == "Oscillation" then "refactorer"
       else empty
       end
     ) | unique | .[]
   ')
   PREPEND=""
   for p in $(echo "$FILTERED_PERSONAS"); do
     pf="${PROJECT_ROOT}/.harness/skills/do/personas/generator/${p}.md"
     [ -f "$pf" ] && PREPEND="${PREPEND}$(cat "$pf")\n\n---\n\n"
   done
   EVALUATOR_FEEDBACK_AUGMENTED="${PREPEND}${EVALUATOR_FEEDBACK}"

6. Generator 재호출 (EVALUATOR_FEEDBACK_AUGMENTED 전달, SPRINT_SPEC은 변경 없음)
   → Phase 5a로 돌아가 Generator 재실행 (GEN_RETRY_COUNT는 증가된 상태 유지)
```

GENERATOR_HISTORY_FILE(`generator-history.jsonl`)은 Generator 전용 history 파일이다.
ITERATOR_HISTORY_FILE(`iterator-history.jsonl`)은 Iterator 전용 history 파일이다.
두 파일 모두 `.do-state/<session-id>/`에 독립적으로 존재하며, detect-stagnation.sh는 호출 측이 전달하는 파일 인자만 분석한다.

#### Phase 5a-post: 구현 완료 주장 검증

Generator 완료 직후 Orchestrator가 즉시 실행:

```bash
git diff --name-only HEAD
```

결과를 ACTUAL_CHANGES로 저장. Generator 출력의 "변경 파일 요약" 목록과 비교:

- Generator가 보고했으나 ACTUAL_CHANGES에 없는 파일 → CLAIM_GAP에 추가

CLAIM_GAP이 있으면 Gap Detector 호출 시 함께 전달한다.
CLAIM_GAP 자체는 FAIL이 아니다 — Gap Detector가 해당 파일을 우선 조사하여 실제 누락 여부를 판단한다.

#### Phase 5b: 검증 요청

`git diff --stat HEAD`를 실행하여 DIFF_STAT을 수집한다.
UI route/page/component 경로 변경 포함 여부를 HAS_UI_CHANGES로 판단한다.

> **확장된 HAS_UI_CHANGES 판정**: AFFECTED_FILES나 diff에 `client/`, `web/`,
> `app/`, `pages/`, `components/`, `ui/`, `views/` 같은 UI 경로가 있거나,
> Product Spec의 데이터 수명주기 표에서 "소비" 열에 UI 컴포넌트가 명시된 경우
> true로 설정한다.

Gap Detector는 서브 에이전트로 실행한다. 검증 단계는 구현 컨텍스트로부터 독립된 컨텍스트에서 수행해야 편향이 없다.

`agents/gap-detector.md`를 Read하여 프롬프트로 사용.

**Gap Detector 서브 에이전트 호출** (effort: high, mode: auto):

```
입력 변수:
- PRODUCT_SPEC: {전체 Product Spec}
- SPRINT_NUMBER: {현재 Sprint 번호}
- DIFF_STAT: {git diff --stat HEAD 결과}
- HAS_UI_CHANGES: {true|false}
- CLAIM_GAP: {CLAIM_GAP 목록 또는 빈 값}
- DESIGN_VALIDATION: {Phase 4b 결과 또는 빈 값}
- PM_CONTEXT: {PM 섹션 또는 빈 값}
- STATE_FILE: {.do-state/<session-id>/sprint-state.json 절대 경로}
- PROJECT_ROOT: {프로젝트 루트 경로}
```

Gap Detector의 Match Rate + Gap Analysis + VERDICT 결과를 수신한다.

> **Failure Taxonomy**: Gap Detector는 Match Rate 외에 6가지 Taxonomy 분류
> (reference-noise / layout-mismatch / text-content-mismatch / state-mismatch / semantic-mismatch / preflight-missing-input)
> 를 함께 반환한다. Taxonomy 분류는 Gap Analysis의 원인 열에 `[taxonomy-type]` 접두사로 표시되며,
> Iterator가 taxonomy별 최적 수정 전략을 선택하는 데 사용된다.
> 상세 분류 기준은 `references/failure-taxonomy.md` 참조.

#### Phase 5c: 판정 및 수정 루프

**Sprint 진입 시 초기화:**

```
RETRY_COUNT = 0
PREV_GAP_FINGERPRINT = null
```

Gap Detector가 반환한 VERDICT를 파싱한다:

- `VERDICT: PASS` (≥90%) → 아래 순서로 진행 후 Phase 5d로:
  1. verification-history.jsonl에 결과 append (Bash):
     ```bash
     echo "{\"sprint\": N, \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\", \"match_rate\": X, \"verdict\": \"PASS\", \"iterations\": N, \"gap_summary\": \"...\"}" >> "${HISTORY_FILE}"
     ```
  2. **Browser Validation Gate** (`HAS_UI_CHANGES=true` 시만):

     Skill tool로 `/browser-validate` 호출:
     ```
     입력 변수:
     - TARGET_URL: PRODUCT_SPEC의 현재 Sprint Tasks에서 영향받는 UI 라우트 추출
       (명시 없으면 package scripts, env, 실행 중인 dev server, 또는 사용자 입력에서 확인. 확인 불가 시 `TARGET_URL_REQUIRED`로 표시하고 사용자에게 URL 확인 요청)
     - INTERACTION_DESCRIPTION: Sprint 수락 기준의 핵심 인터랙션 1개 추출
       (예: "대시보드 페이지 로드 후 세션 목록 표시 확인")
     - SESSION_ID: 현재 /do 세션 ID
     - SPRINT_NUMBER: 현재 Sprint 번호
     - PROJECT_ROOT: 프로젝트 루트
     ```

     `/browser-validate` 결과 처리:
     - `verdict: "PASS"` → 3단계로 진행
     - `verdict: "FAIL"` →
       - `browser_validate_issues`를 GAP_ANALYSIS에 추가
       - `VERDICT: RETRY`로 처리하여 Phase 5c-1 Iterator 호출
       - Iterator 수정 완료 후 `/browser-validate` **재실행 1회**
       - 재실행 후에도 FAIL → 사용자에게 판단 위임 (browser validation 이슈 상세 포함)

  3. session-meta.json 업데이트 (`.tmp → rename`):
     ```bash
     jq ".last_sprint = N | .resume_from = \"phase_5d\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
     ```
- `VERDICT: RETRY` (70-89% 또는 Deterministic FAIL) → Phase 5c-1로
- `VERDICT: FAIL` (<70%) → 실패 내용을 사용자에게 보고하고 판단 위임

**Phase 5c-1: Iterator 호출** (RETRY 시)

**Phase 5c-1 실행 의사코드** (페르소나 주입을 fingerprint 조기 중단보다 우선):

```
0. RETRY 진입 직후 (모든 분기 공통 가드):
   RETRY_COUNT += 1
   if RETRY_COUNT > 4:
       → "최대 retry 4회(3 일반 + 1 페르소나 시도) 초과" + Gap Analysis를 사용자에게 보고하고 판단 위임 (loop 종료)

1. detect-stagnation.sh 실행
   → JSON 출력 파싱하여 personas 배열 획득

2. personas 배열 비어있지 않으면:
   a. 각 persona MD를 Read하여 GAP_ANALYSIS 앞에 prepend (구분선 ---)
   b. Iterator 서브 에이전트 호출 (prepended GAP_ANALYSIS 전달)
   c. Iterator 종료 직후 iterator-history.jsonl append (output_hash 포함)
   d. PREV_GAP_FINGERPRINT 갱신 → return (continue loop)

3. personas 배열 비어있고 current_fingerprint == PREV_GAP_FINGERPRINT:
   3a. history.length < 3 (패턴 검사에 history가 충분치 않음)
       → Iterator 호출 (원본 GAP_ANALYSIS) → history append → continue
       (history가 누적되어 다음 retry에서 detect-stagnation이 발화할 기회 보장)
   3b. history.length >= 3 이고 detect-stagnation이 빈 결과 반환 (패턴 미매칭)
       → 사용자 위임 (기존 "2회 연속 동일 실패" 조기 중단 발화)

4. 그 외 (페르소나 없음 & fingerprint 달라짐, history.length 무관):
   → Iterator 호출 (원본 GAP_ANALYSIS) → history append → PREV_GAP_FINGERPRINT 갱신

위 순서로 페르소나 주입을 fingerprint 조기 중단보다 우선 시도하여 Spinning 패턴 3회 트리거가
fingerprint 2회 조기 중단에 가려지지 않게 한다.
또한 fingerprint cutoff는 history.length >= 3일 때만 발화하여 detect-stagnation에 충분한
history 누적 기회를 보장한다.
```

**연속 동일 실패 체크 (Step 1 이후, fingerprint 조기 중단 판별):**

```
current_fingerprint = GAP_ANALYSIS 실패 항목 ID를 정렬한 목록
if current_fingerprint == PREV_GAP_FINGERPRINT:
    if history.length < 3:
        → retry 계속 (history 누적 기회 부여, detect-stagnation 발화 기회 보장)
        (PREV_GAP_FINGERPRINT 갱신 후 continue — 조기 중단 발화하지 않음)
    else:  # history.length >= 3
        → "2회 연속 동일 실패" + Gap Analysis를 사용자에게 보고하고 판단 위임 (조기 중단)
PREV_GAP_FINGERPRINT = current_fingerprint
```

**detect-stagnation.sh 호출 및 GAP_ANALYSIS prepend:**

```bash
# detect-stagnation.sh 실행
PROJECT_ROOT=$(git rev-parse --show-toplevel)
ITERATOR_HISTORY_FILE="${PROJECT_ROOT}/.do-state/${SESSION_ID}/iterator-history.jsonl"
[ -f "$ITERATOR_HISTORY_FILE" ] || touch "$ITERATOR_HISTORY_FILE"
STAGNATION_JSON=$(bash "${PROJECT_ROOT}/.harness/skills/do/scripts/detect-stagnation.sh" "$ITERATOR_HISTORY_FILE" --current-sprint "$CURRENT_SPRINT")
INJECTED_PERSONAS=$(echo "$STAGNATION_JSON" | jq -r '.personas | join(",")')

# personas 비어있지 않으면 GAP_ANALYSIS 앞에 persona MD 본문 prepend
if [ -n "$INJECTED_PERSONAS" ]; then
  PREPEND=""
  for p in $(echo "$STAGNATION_JSON" | jq -r '.personas[]'); do
    # 페르소나 이름이 소문자화된 파일명과 일치
    pf="${PROJECT_ROOT}/.harness/skills/do/personas/iterator/$(echo "$p" | tr '[:upper:]' '[:lower:]').md"
    [ -f "$pf" ] && PREPEND="${PREPEND}$(cat "$pf")\n\n---\n\n"
  done
  GAP_ANALYSIS_AUGMENTED="[정체 패턴 감지: $(echo "$STAGNATION_JSON" | jq -r '.patterns | join(", ")')]

${PREPEND}${GAP_ANALYSIS}"
else
  GAP_ANALYSIS_AUGMENTED="${GAP_ANALYSIS}"
fi

# Iterator 호출 (GAP_ANALYSIS_AUGMENTED 전달)
```

`agents/iterator.md`를 Read하여 프롬프트로 사용.

**Iterator 서브 에이전트 호출** (effort: xhigh, mode: auto):

```
입력 변수:
- GAP_ANALYSIS: {GAP_ANALYSIS_AUGMENTED — 페르소나 prepend 포함 또는 원본}
- PRODUCT_SPEC: {전체 Product Spec}
- CONTEXT_MODULES: {Phase 3에서 로드한 내용}
- PROJECT_ROOT: {프로젝트 루트 경로}
```

**iterator-history.jsonl append (Iterator 종료 직후):**

```bash
# Iterator 종료 직후: history append (output_hash는 git diff에서 산출, normalize 인라인)
ITER_TRACKED_DIFF=$(git diff HEAD)
ITER_UNTRACKED_LIST=$(git ls-files --others --exclude-standard | sort)
ITER_UNTRACKED_DIGEST=""
if [ -n "$ITER_UNTRACKED_LIST" ]; then
  while IFS= read -r ut_file; do
    [ -f "$ut_file" ] || continue
    ut_hash=$(sha256sum -- "$ut_file" 2>/dev/null | awk '{print $1}')
    ITER_UNTRACKED_DIGEST="${ITER_UNTRACKED_DIGEST}${ut_file}:${ut_hash}"$'\n'
  done <<< "$ITER_UNTRACKED_LIST"
fi
ITER_HASH=$(printf '%s\n--untracked--\n%s' "$ITER_TRACKED_DIFF" "$ITER_UNTRACKED_DIGEST" | awk '{$1=$1;print}' | tr -s ' ' | grep -v '^$' | sha256sum | awk '{print $1}')
MATCH_RATE_NUM=${MATCH_RATE:-0}  # Gap Detector가 산출한 값
ITERATION_NUM=$((${ITERATION_NUM:-0} + 1))
PERSONAS_JSON=$(echo "$STAGNATION_JSON" | jq -c '.personas // []' 2>/dev/null || echo '[]')

jq -n \
  --argjson sprint "$CURRENT_SPRINT" \
  --argjson iteration "$ITERATION_NUM" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg hash "$ITER_HASH" \
  --argjson rate "$MATCH_RATE_NUM" \
  --arg fp "${current_fingerprint:-}" \
  --argjson personas "$PERSONAS_JSON" \
  '{sprint:$sprint, iteration:$iteration, timestamp:$ts, output_hash_normalized:$hash, match_rate:$rate, gap_fingerprint:$fp, injected_personas:$personas}' \
  >> "$ITERATOR_HISTORY_FILE"
```

Iterator 완료 후 `git diff --name-only HEAD`로 ACTUAL_CHANGES 갱신 → CLAIM_GAP 재계산.
Phase 5b Gap Detector 재검증 (별도 sub-agent 호출로 편향 없이 재검증).

#### Phase 5d: Sprint 완료

Sprint PASS 확정 후 sprint-state.json을 갱신한다:

```bash
# 현재 Sprint의 신규 테스트 파일 추출
NEW_TESTS=$(git diff --name-only HEAD | grep -E '\.(test|spec)\.ts$')

# sprint-state.json 원자적 업데이트 (.tmp → rename)
jq \
  --argjson new_tests "$(echo "$NEW_TESTS" | jq -R . | jq -s .)" \
  --argjson sprint_num N \
  '.p2p_suite = $new_tests |
   .canary_suite = (.canary_suite + $new_tests | unique) |
   .current_sprint = $sprint_num |
   .updated_at = "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"' \
  "${STATE_FILE}" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "${STATE_FILE}"
```

> **p2p_suite**: 직전 Sprint 테스트만 유지 (Sprint N → Sprint N+1 P2P Gate용으로 교체)
> **canary_suite**: 모든 Sprint 테스트 누적 (append + unique)

Phase 5e로 진행하기 전 session-meta.json도 업데이트:
```bash
jq ".resume_from = \"phase_5e\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"
```

**D3 Cross-Sprint 메타-정체 감지**: session-meta.json 업데이트 직후, Phase 5e 진입 전에 cross-sprint 정체 탐지기를 실행한다. 같은 정체 패턴(Spinning, Oscillation 등)이 **3개 이상의 distinct sprint**에서 반복 감지되면 메타-정체로 판정하고 AskUserQuestion으로 사용자 개입을 요청한다. 임계값 3은 sprint 1~2 의 일시적 회복 패턴을 false positive로 분류하지 않기 위한 설계 결정이다(D3, 2026-05-11).

```bash
# Cross-sprint meta-stagnation 감지 (D3)
# ITERATOR_HISTORY_FILE은 Iterator retry 경로에서 설정되지만, clean PASS 경로에서는 미설정일 수 있음 → 안전하게 재파생
ITERATOR_HISTORY_FILE="${ITERATOR_HISTORY_FILE:-${PROJECT_ROOT}/.do-state/${SESSION_ID}/iterator-history.jsonl}"
[ -f "$ITERATOR_HISTORY_FILE" ] || touch "$ITERATOR_HISTORY_FILE"
CROSS_EXIT=0
CROSS_RESULT=$(bash "${PROJECT_ROOT}/.harness/skills/do/scripts/detect-stagnation-cross-sprint.sh" "$ITERATOR_HISTORY_FILE") || CROSS_EXIT=$?
# exit 2 또는 error:"malformed_history" → iterator-history.jsonl 손상: 자동 진행 금지, 사용자에게 보고
if [ "$CROSS_EXIT" -eq 2 ] || [ "$(echo "$CROSS_RESULT" | jq -r '.error // empty')" = "malformed_history" ]; then
  # 손상된 history 파일로 인해 cross-sprint 감지 불가 → AskUserQuestion으로 사용자 판단 위임
  :
elif [ "$(echo "$CROSS_RESULT" | jq -r '.meta_stagnation')" = "true" ]; then
  META_PATTERN=$(echo "$CROSS_RESULT" | jq -r '.pattern')
  META_SPRINTS=$(echo "$CROSS_RESULT" | jq -r '.sprints | join(",")')
fi
```

**Orchestrator는** `CROSS_EXIT`이 2이거나 `CROSS_RESULT.error`가 `malformed_history`인 경우 **반드시 `AskUserQuestion`을 호출**하여 다음 문구로 사용자 판단을 요구한다: ⚠️ iterator-history.jsonl 손상 감지 — 손상된 history로는 메타-정체 게이트 신뢰 불가. 옵션: (1) 손상 무시하고 진행 (2) /do 종료 후 디버그. (2) 선택 시 session-meta.json status를 `'paused'`로 마킹 후 종료. 응답 받기 전까지 Phase 5e 진입 금지.

Orchestrator는 `META_PATTERN`이 빈 값이 아니면 **반드시 `AskUserQuestion`을 호출**하여 다음 문구로 사용자 판단을 요구한다:

> ⚠️ 메타-정체 감지: 패턴 '{META_PATTERN}'이 Sprint [{META_SPRINTS}]에서 반복되었습니다. 전체 작업 계획을 재검토하겠습니까? — 옵션: (1) 계속 진행 (2) /do 종료 후 재계획

사용자가 응답할 때까지 Phase 5e 진입을 금지한다. (2) 선택 시 session-meta.json의 status를 `'paused'`로 마킹 후 /do를 종료한다.

- 다음 Sprint가 있으면 → Phase 5e로
- 마지막 Sprint → Phase 5e로 (이후 Phase 6)

#### Phase 5e: Review Gate

Sprint 구현 완료 직후 외부 코드 리뷰 command가 설정되어 있으면 실행한다.

> **실행 모델**: review command는 **동일 프로세스 내 동기(foreground) 실행**이다.
> Paveda는 특정 reviewer 구현을 내장하지 않는다. 프로젝트가 `PAVEDA_CODE_REVIEW_COMMAND`를
> 설정하면 실행하고, 미설정이면 Review Gate를 N/A로 기록한다.

**실행 (Bash 직접 호출 — optional):**

```bash
REVIEW_SOURCE="not-configured"; REVIEW_OUTPUT=""; REVIEW_EXIT=0

if [ -n "${PAVEDA_CODE_REVIEW_COMMAND:-}" ]; then
  DIFF=$(git diff HEAD 2>/dev/null || git diff 2>/dev/null)
  REVIEW_OUTPUT=$(PAVEDA_REVIEW_DIFF="$DIFF" sh -c "$PAVEDA_CODE_REVIEW_COMMAND" 2>&1)
  REVIEW_EXIT=$?
  REVIEW_SOURCE="external"
fi
```

**결과 파싱 및 처리:**

- `REVIEW_SOURCE = "not-configured"` 인 경우 → 완료 보고 Row 16을 `N/A`로 표시
- `REVIEW_EXIT != 0` 인 경우 → `WARN`으로 표시하고 원문을 Deferred Spec에 기록
- **REVIEW_ISSUES = []** (지적 없음) → 다음 Sprint(Phase 5a) 또는 Phase 6으로 진행
- **REVIEW_ISSUES 있음** → 심각도별 분류 (coverage-first: 리뷰어는 LOW 포함 모든 이슈를 보고, 필터링은 Orchestrator가 여기서 수행):
  - **HIGH/MEDIUM** 이슈 존재 → Phase 5e-1 (Iterator 즉시 수정)
  - **LOW only** → Deferred Spec에 기록 후 다음 Sprint 또는 Phase 6으로 진행 (Iterator 호출 없음)

**Phase 5e-1: Review 이슈 기반 수정**

Iterator 서브 에이전트 호출 (effort: xhigh, mode: auto). `GAP_ANALYSIS` 자리에 `REVIEW_ISSUES`(HIGH/MEDIUM 이슈만 포함)를 전달:

```
입력 변수:
- GAP_ANALYSIS: {REVIEW_ISSUES 중 HIGH/MEDIUM severity 항목}
- PRODUCT_SPEC: {전체 Product Spec}
- CONTEXT_MODULES: {Phase 3에서 로드한 내용}
- PROJECT_ROOT: {프로젝트 루트 경로}
```

수정 완료 후 Gap Detector 재검증 **1회**:

- **PASS** (≥90%) → 다음 Sprint 또는 Phase 5e-2
- **FAIL** (<90%) → REVIEW_ISSUES + Gap Analysis를 사용자에게 보고, 판단 위임

> **재검증은 1회만** — 1회 수정 후 FAIL이면 자동 반복하지 않는다. 기존 Phase 5c의 최대 3회 RETRY와 별개 카운터.

**Phase 5e-2: Adversarial Test Generation**

Review Gate 통과(이슈 없거나 수정 완료) 후, 별도 서브에이전트(effort: xhigh, mode: auto)가 구현을 깨뜨릴 수 있는 입력을 생성하여 검증한다.

```
입력 변수:
- PRODUCT_SPEC: {현재 Sprint 섹션}
- AFFECTED_FILES: {Phase 5a-post의 ACTUAL_CHANGES}
```

**서브에이전트 지시**:
```
다음 구현에 대해 "의도적으로 실패를 유발하는" 테스트 케이스 3~5개를 생성하고 실행하라.
집중 영역:
1. 경계값: 빈 문자열, 0, 음수, null, undefined
2. 인증: 권한 없는 사용자가 접근 가능한가
3. 동시성: 같은 요청이 두 번 연속 오면 어떻게 되는가
4. 대용량: 예상보다 10배 많은 데이터가 입력되면

각 케이스를 실제 실행하고 PASS/FAIL을 보고하라.
FAIL = 구현 취약점 발견.
```

**결과 처리**:
- 취약점 없음 → 다음 Sprint 또는 Phase 6
- 취약점 발견 → Gap Analysis에 추가 후 Iterator 수정 → Adversarial 재실행 1회
- 재실행 후에도 FAIL → Deferred Spec에 기록 후 진행

### Phase 6: Completion Report + Deferred Spec

#### Phase 6a: Completion Report

> **Command Resolution**: Lint/Test/Build commands are resolved from the current
> repository's package manager metadata and `package.json` scripts. Missing
> commands are recorded as `SKIP`; do not create new project configuration during
> completion reporting.

**실행 (repo metadata에서 커맨드 해석):**

```bash
PKG_MANAGER="pnpm"
PACKAGE_MANAGER_FIELD=""
if [ -f "${PROJECT_ROOT}/package.json" ]; then
  PACKAGE_MANAGER_FIELD=$(node -e "const p=require(process.argv[1]); console.log(p.packageManager || '')" \
    "${PROJECT_ROOT}/package.json" 2>/dev/null || true)
fi
case "$PACKAGE_MANAGER_FIELD" in
  npm@*) PKG_MANAGER="npm" ;;
  yarn@*) PKG_MANAGER="yarn" ;;
  pnpm@*) PKG_MANAGER="pnpm" ;;
esac
[ -f "${PROJECT_ROOT}/pnpm-lock.yaml" ] && PKG_MANAGER="pnpm"
[ -f "${PROJECT_ROOT}/package-lock.json" ] && PKG_MANAGER="npm"
[ -f "${PROJECT_ROOT}/yarn.lock" ] && PKG_MANAGER="yarn"

has_script() {
  node -e "const p=require(process.argv[1]); process.exit(p.scripts && p.scripts[process.argv[2]] ? 0 : 1)" \
    "${PROJECT_ROOT}/package.json" "$1" 2>/dev/null
}

if [ -f "${PROJECT_ROOT}/package.json" ] && has_script lint; then
  (cd "${PROJECT_ROOT}" && ${PKG_MANAGER} lint) && LINT_RESULT=PASS || LINT_RESULT=FAIL
else
  LINT_RESULT=SKIP
fi

if [ -f "${PROJECT_ROOT}/package.json" ] && has_script test; then
  (cd "${PROJECT_ROOT}" && ${PKG_MANAGER} test) && TEST_RESULT=PASS || TEST_RESULT=FAIL
else
  TEST_RESULT=SKIP
fi

if [ -f "${PROJECT_ROOT}/package.json" ] && has_script build; then
  (cd "${PROJECT_ROOT}" && ${PKG_MANAGER} build) && BUILD_RESULT=PASS || BUILD_RESULT=FAIL
else
  BUILD_RESULT=SKIP
fi
```

```
## 완료: {TASK_DESCRIPTION}

### 변경 사항
- {파일}: {변경 내용 요약}

### 최종 검증 결과

| # | 항목 | 결과 |
|---|------|------|
| 1 | Lint | PASS/FAIL |
| 2 | Test | PASS/FAIL |
| 3 | Build | PASS/FAIL |
| 4 | Command Source | package metadata / skipped |
| 5 | 완전성 | PASS/FAIL |
| 6 | 정합성 | PASS/FAIL |
| 7 | 테스트 커버리지 | PASS/FAIL |
| 8 | 스코프 준수 | PASS/FAIL |
| 9 | 코드 품질 | PASS/FAIL |
| 10 | 완료 기준 | PASS/FAIL |
| 11 | 설계 결정 준수 | PASS/FAIL |
| 12 | 패턴 준수 | PASS/FAIL |
| 13 | 사용자 가시성 | PASS/FAIL |
| 14 | 텍스트 품질 | PASS/FAIL/N/A |
| 15 | 플러그인 검증 | PASS/WARN/N/A |
| 16 | E2E (해당 시) | PASS/FAIL/N/A |
| 17 | Review Gate | PASS/WARN/N/A |
| 18 | Adversarial Review | PASS/WARN/N/A |
| 19 | Adversarial Tests (5e-2) | PASS/WARN/N/A |
| 20 | P2P Gate (Sprint 간 회귀) | PASS/WARN/N/A |

### Match Rate 추이

> **데이터 소스**: `cat "${HISTORY_FILE}"` 로 verification-history.jsonl을 읽어 각 줄을 파싱하여 아래 테이블을 생성한다.

| 이터레이션 | Match Rate | Verdict | 주요 개선 |
|-----------|------------|---------|-----------|
| 1차 | {X}% | {verdict} | {개선 내용} |
| 2차 | {X}% | {verdict} | {개선 내용} |

Sprint 수: {N}개
이터레이션 횟수: {총 횟수}회

### Failure Classification

> **데이터 소스**: Gap Detector의 taxonomy 분류 결과를 집계.
> 각 수정 항목의 taxonomy 분류와 수정 전환율(PASS로 전환된 비율)을 기록.

| Taxonomy | 발생 횟수 | 수정 전환율 |
|----------|-----------|------------|
| reference-noise | {N}회 | {X}% |
| layout-mismatch | {N}회 | {X}% |
| text-content-mismatch | {N}회 | {X}% |
| state-mismatch | {N}회 | {X}% |
| semantic-mismatch | {N}회 | {X}% |
| preflight-missing-input | {N}회 | {X}% |

### 별도 작업 (Deferred)
> 이 섹션은 스코프 외 항목이 있을 때만 표시.
| ID | 이슈 | 해결 방향 |
|----|------|-----------|
→ 상세: docs/deferred/{date}-{task}-deferred.md

### 다음 단계
→ `/commit`으로 커밋하시겠습니까?
```

Phase 6a 완료 후 session-meta.json을 완료 상태로 마킹한다 (HISTORY_FILE이 존재하는 경우):
```bash
jq ".status = \"completed\" | .updated_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "${META_FILE}" > "${META_FILE}.tmp" && mv "${META_FILE}.tmp" "${META_FILE}"

# --- INDEX.md 상태 업데이트: IN_PROGRESS → done ---
# PLAN_FILE은 Phase 4d에서 설정된 plan 파일 경로
if [ -n "$PLAN_FILE" ]; then
  ESCAPED_PATH=$(echo "$PLAN_FILE" | sed 's|/|\\/|g')
  sed -i '' "/$ESCAPED_PATH/ s/IN_PROGRESS/done/" "$PROJECT_ROOT/docs/INDEX.md"
  echo "INDEX.md: $PLAN_FILE → done"
fi
```

#### Phase 6b: Deferred Spec 생성

Product Spec에 "스코프 외" 항목이 1개 이상 존재하면, `docs/deferred/`에 git-tracked 문서를 생성한다.
스코프 외 항목이 없으면 이 Phase를 건너뛴다.

> Phase 6c에서 WARN/CRITICAL 항목이 추가될 수 있으므로, Deferred Spec 파일 경로를 DEFERRED_SPEC_PATH로 기억해둔다.

**파일명**: `docs/deferred/{YYYY-MM-DD}-{task-kebab}-deferred.md`

**구조** (Paveda structured documentation 규칙 준수):

```markdown
---
title: "{TASK_DESCRIPTION} — 후속 작업"
date: {YYYY-MM-DD}
category: deferred
status: TODO
---

# {TASK_DESCRIPTION} — 후속 작업

> 이 문서는 /do 실행 중 식별되었으나 스코프에서 제외된 항목을 추적한다.
> 원본 Product Spec: docs/plans/{spec-filename}.md

## 항목

### {ID}: {이슈 제목}

**현상**: {무엇이 문제인가}

**제외 이유**: {왜 이번 스코프에 포함하지 않았는가}

**해결 방향**:
1. {접근 방법 1}
2. {접근 방법 2}

(각 스코프 외 항목마다 반복)
```

생성 후 `docs/INDEX.md`를 업데이트한다 (status: TODO로 등록).

#### Phase 6c: Adversarial Review Gate

전체 구현 완료(Phase 6b) 후 설계 결정 전체에 도전적 검토를 수행한다.

**실행 (Bash 직접 호출, main 브랜치 기준 전체 PR diff — optional):**

```bash
ADV_SOURCE="not-configured"; ADV_OUTPUT=""; ADV_EXIT=0

if [ -n "${PAVEDA_ADVERSARIAL_REVIEW_COMMAND:-}" ]; then
  FULL_DIFF=$(git diff main...HEAD 2>/dev/null)
  ADV_OUTPUT=$(PAVEDA_REVIEW_DIFF="$FULL_DIFF" sh -c "$PAVEDA_ADVERSARIAL_REVIEW_COMMAND" 2>&1)
  ADV_EXIT=$?
  ADV_SOURCE="external"
fi
```

**결과 파싱 및 심각도 분류:**

| 심각도 | 기준 |
|--------|------|
| CRITICAL | 설계 가정 자체가 틀렸거나, 실환경(동시성·장애·엣지케이스)에서 명백히 실패하는 경우 |
| WARN | 더 나은 접근법이 있으나 현재 구현도 작동하는 경우, 또는 향후 확장 시 문제가 될 수 있는 경우 |

> **출력 원문을 그대로 파싱** — Orchestrator가 심각도를 재판단하지 않는다.
> adversarial-review 출력에 명시된 severity 레이블을 기준으로 분류.
> severity 레이블이 없으면 전체를 WARN으로 처리한다.

**처리 규칙:**

```
DESIGN_ISSUES = [] → 종료

CRITICAL 있음
  → AskUserQuestion으로 사용자 판단 위임:
    - 수정 결정 → Iterator/Generator 수정 → review command 재실행 1회 → 종료
    - 무시 결정 → Deferred Spec에 CRITICAL 항목 추가 후 종료

WARN만 있음
  → Deferred Spec에 WARN 항목 추가 후 종료
```

**Deferred Spec 연동:**

- `DEFERRED_SPEC_PATH`가 있으면 (Phase 6b에서 생성됨) → 해당 파일에 `### Adversarial Review 지적 사항` 섹션을 **append**
- `DEFERRED_SPEC_PATH`가 없으면 (Phase 6b를 건너뜀) → Phase 6b 규칙과 동일한 방식으로 deferred 파일 신규 생성, `docs/INDEX.md` 업데이트

## Tool Call 효율 규칙

1. **Edit vs Write 선택**: 파일의 1~2곳 수정 → Edit, 3곳 이상 수정 → Read 후 Write로 전체 교체
2. **검증 에이전트 통합**: 검증 대상 파일 10개 이하 → 에이전트 1개로 통합. 10개 초과 시만 분리 (최대 2개)
3. **수정 반복 제한**: Iterator → Gap Detector 재검증이 2회 연속 RETRY면 사용자 판단 위임 (3회까지 허용하되, 동일 항목이 2회 연속 잔존 시 조기 중단)

## Design Principles

1. **컨텍스트 방화벽**: 각 서브 에이전트는 독립된 컨텍스트 윈도우에서 실행. 결과는 압축하여 Orchestrator에 반환.
2. **Success is silent, failures verbose**: 통과 결과는 요약만, 실패는 상세히.
3. **점진적 공개**: 각 에이전트는 필요한 reference만 Read.
4. **Merge-ready 유지**: 각 Sprint 완료 시 코드가 항상 배포 가능 상태.
5. **PDCA 분리**: Plan(Planner) → Design(Validator) → Do(Generator) → Check(Gap Detector) → Act(Iterator). 각 단계를 전담 에이전트가 수행.
6. **Orchestrator는 코드를 직접 수정하지 않는다**: sub-agent 결과에 누락이 발견되면, Orchestrator가 직접 코드를 고치지 않고 해당 책임의 에이전트(Iterator/Generator)를 재호출한다. "에이전트가 여러 곳을 누락했습니다. 직접 수정합니다."는 금지. 누락 항목을 구체적으로 나열하여 적절한 에이전트에게 위임한다.
7. **입력 형태와 무관한 파이프라인 강제**: 파일을 Read했거나, TASK_DESCRIPTION에 상세 구현 계획이 담겨 있거나, deferred/spec 파일 내용이 풍부하더라도 — Orchestrator가 "이미 충분히 알고 있으니 에이전트를 생략한다"는 판단을 내리는 것을 금지한다. Design Validator → Generator 체인은 IS_FROM_SPEC / IS_FROM_DEFERRED 여부와 무관하게 항상 실행된다.

## Model Tier Allocation

> Tier 기준: `frontier` = 장문 계획·검증, `standard` = 구현·반복·분석 기본값. Effort 기준: `xhigh` = 코딩·에이전트 최적, `high` = 검증·분석 균형, `max` = 과도한 추론 위험으로 비권고

| 에이전트 | Tier | Effort | Mode | PDCA | 실행 방식 | 이유 |
|----------|------|--------|------|------|----------|------|
| Orchestrator | frontier | — | — | — | 메인 세션 | 전체 파이프라인 조율, 사용자 컨텍스트 유지 |
| **Codebase Scout** | standard | high | auto | Pre-Plan | sub-agent (AFFECTED_FILES ≥ 15) | 광역 탐색 + 핵심 파일 실측, 대규모 코드베이스 지도 생성 |
| Planner | frontier | **xhigh** | auto | Plan | agents/planner.md Read → sub-agent | 코딩·에이전트 최적값. max는 overthinking 위험 |
| Design Validator | frontier | **xhigh** | auto | Design | agents/design-validator.md Read → sub-agent | 동일. 장문 스펙 처리에 64k 토큰 버짓 필수 |
| Generator | standard | **xhigh** | auto | Do | sub-agent | 코딩 작업 최적값, tool usage 극대화 |
| Gap Detector | standard | **high** | auto | Check | sub-agent | 독립 컨텍스트에서 정량적 검증, 구현 편향 제거 |
| Iterator | standard | **xhigh** | auto | Act | sub-agent | 코딩 수정 작업 최적값 |
| Adversarial Tester | standard | **xhigh** | auto | Check | sub-agent (Phase 5e-2) | 경계값·동시성·인증 취약점 탐색 |

## $ARGUMENTS

- `<task description>`: 수행할 작업 설명 (필수)
- `--from-spec <path>`: 인터뷰 + Planner 생략. 기존 스펙 파일을 PRODUCT_SPEC으로 직접 사용, Design Validator부터 실행
- `--from-deferred <path>`: 인터뷰만 생략. deferred 파일 내용을 PM_CONTEXT로 전달하여 Planner부터 전체 파이프라인 실행. `docs/deferred/` 경로가 TASK_DESCRIPTION에 포함된 경우 자동 활성화
