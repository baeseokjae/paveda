---
name: plan
description: "구현 전 Plan-only 단계 — /specify 인터뷰 → Impact Analysis → packaged context module 로드 → Planner → Design Validator → docs/plans/ 저장까지 수행한다. 사용자가 '계획만 세워줘', '구현 계획서 만들어줘', '/do 돌리기 전에 plan 먼저', '스펙 파일 검토'를 요청하거나, 구현 전 충분한 설계 검증이 필요한 모든 상황에서 트리거하라. 산출물은 /do --from-spec 으로 그대로 인계 가능."
argument-hint: "[--from-spec <path> | --from-deferred <path>] <task description>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, Skill, Agent
---

# /plan — Plan-only Pipeline

작업 설명을 받아 **Plan 단계까지만** 실행한다. PDCA 사이클의 Plan + Design 단계를 전담하며, 이후 구현(Sprint Loop)은 `/do --from-spec <plan-path>`로 인계한다.

## Architecture

```
사용자 프롬프트 → /plan
                  │
                  ├─ Phase 1: 인수 파싱 (--from-spec / --from-deferred 플래그)
                  │
                  ├─ Phase 1.5: Interview Gate (/specify 위임)
                  │     └─ --from-spec/--from-deferred 시 스킵
                  │
                  ├─ Phase 1.6: Ambiguity Score 게이트
                  │
                  ├─ Phase 2: Impact Analysis (AFFECTED_FILES + AFFECTED_TESTS)
                  │   └─ Phase 2b/2c: Codebase Context / Codebase Scout (조건부)
                  │
                  ├─ Phase 3: Reference Context 로드 (+ codebase synthesis fallback)
                  │   └─ Phase 3b: 외부 리서치 (/find-skills, /deep-research 위임)
                  │
                  ├─ Phase 4a: Planner Agent → Product Spec
                  ├─ Phase 4b: Design Validator Agent
                  │     ├─ 기본 검증 + Spec 완성도 + PM 리스크 (pm-execution:pre-mortem 위임)
                  │     └─ HAS_UI_CHANGES=true → /impeccable 위임 (UI/UX 검증)
                  │
                  ├─ Phase 4b-2: Plan Quality Gate
                  ├─ Phase 4c: 사용자 승인 게이트
                  └─ Phase 4d: docs/plans/ 저장 + INDEX.md 등록 → PLAN_FILE 반환
```

**Sprint Loop / Generator / Gap Detector / Iterator / Review Gate는 이 skill에 포함되지 않는다.** 구현은 `/do --from-spec <PLAN_FILE>`로 이어가라.
`/plan`은 테스트나 구현을 작성하지 않는다. 대신 `/do`의 `references/test-rules.md`와 `/debug`의 재현 루프 우선 원칙에 맞춰 `/do`가 실행할 첫 feedback loop, vertical slice, test seam을 계획에 명시해야 한다.

## Usage

```
/plan "세션 목록에 필터링 기능 추가"                              # 인터뷰부터 plan 저장까지
/plan --from-spec docs/specs/2026-05-21-xxx.md                  # 인터뷰 스킵, Design Validator부터
/plan --from-deferred docs/deferred/2026-05-21-xxx-deferred.md  # 인터뷰만 스킵, Planner부터
```

산출물: `docs/plans/{YYYY-MM-DD}-{task-kebab}.md`. 이 파일은 `/do --from-spec`이 그대로 받아 sprint loop를 실행할 수 있는 형식이다.

## 위임 관계

`/plan`은 가능한 모든 단계를 기존 skill에 위임한다 — 중복 구현하지 않는다.

| 단계 | 위임 대상 | 트리거 조건 |
|------|----------|------------|
| Interview + PM 기회 분석 | `/specify --discover` | `--from-spec`/`--from-deferred` 미지정 시 항상 |
| 외부 라이브러리 스킬 탐색 | `/find-skills` | TASK_DESCRIPTION에 외부 서비스명 포함, 스킬이 있을 때 |
| 외부 라이브러리 문서/패턴 리서치 | `/deep-research` | 외부 의존 발견 + 스킬이 있을 때 |
| PM 리스크 점검 | `pm-execution:pre-mortem` | 스킬이 있을 때. 없으면 내장 PM checklist |
| PM 가정 발굴 | `pm-product-discovery:identify-assumptions-existing` | 스킬이 있을 때. 없으면 내장 assumption checklist |
| UI/UX 설계 검증 | `/impeccable` | `HAS_UI_CHANGES == true`이고 스킬이 있을 때. 없으면 내장 UI checklist |
| Frontend 패턴 가이드 | `optional frontend best-practices skill` | UI route/page/component 신규 생성 시 |
| 광역 코드베이스 합성 | Read/Grep/Glob 기반 로컬 합성 | `AFFECTED_FILES >= 9` 또는 새 도메인 |

## Execution Order

### Phase 1: Parse Arguments

1. `$ARGUMENTS`에서 플래그 추출:
   - `--from-spec <path>`: 기존 스펙 파일 기반 Plan 검증 (Interview Gate + Planner 건너뜀, Design Validator부터)
   - `--from-deferred <path>`: deferred 파일 기반 (Interview Gate만 건너뜀, Planner는 실행)
2. 나머지 텍스트 = `TASK_DESCRIPTION`
3. 텍스트 없으면 usage 안내 후 중단
4. **자동 감지**: TASK_DESCRIPTION에 `docs/deferred/` 경로가 포함되면 `--from-deferred`로 간주, 해당 파일을 Read하여 `DEFERRED_CONTEXT`에 저장

### Phase 1.5: Interview Gate

다음 조건에 해당하면 **건너뛴다**:
- `IS_FROM_SPEC = true` (`--from-spec` 사용)
- `IS_FROM_DEFERRED = true`

> Interview Gate를 스킵해도 **Phase 1.6(Ambiguity Score 게이트)는 반드시 통과**해야 한다.

**절대 자체 판단으로 건너뛰지 않는다.** TASK_DESCRIPTION이 길고 상세해 보여도, 파일을 Read해서 내용을 알고 있어도, Orchestrator가 "이미 충분히 알고 있다"고 판단하여 인터뷰를 생략하는 것은 금지다. 인터뷰는 사용자와의 정렬 단계이지 정보 수집 단계가 아니다.

그 외 모든 경우:

1. Skill tool로 `/specify --discover "{TASK_DESCRIPTION}"` 호출
   - `--discover` 플래그는 PM 기회 분석 섹션(제품 기회, 가치 제안, 위험 분석)을 spec에 포함시킨다. 이는 Phase 4a Planner의 Step 1.5b와 Phase 4b Design Validator의 PM 리스크 점검에서 활용된다.
2. 출력에서 `SPEC_PATH:` 라인을 파싱하여 `FROM_SPEC_PATH` 변수에 저장
3. `IS_FROM_SPEC = true` 설정

> 사용자가 인터뷰 중 "건너뛰기", "스킵", "그냥 진행" 신호를 주면 `/specify`의 seed-closer가 즉시 최소 스펙을 생성하고 `SPEC_PATH:`를 반환한다.

### Phase 1.6: Ambiguity Score 게이트

Phase 1.5 직후 시점의 spec 경로는 `FROM_SPEC_PATH`에 있다. frontmatter에서 `ambiguity_score`를 읽어 검증한다.

```bash
SPEC_FILE="${FROM_SPEC_PATH}"
AMBIGUITY_SCORE=$(test -n "$SPEC_FILE" && head -30 "$SPEC_FILE" 2>/dev/null | grep "^ambiguity_score:" | head -1 | awk '{print $2}' | tr -d '"' || true)
[[ "$AMBIGUITY_SCORE" =~ ^[0-9]+(\.[0-9]+)?$ ]] || AMBIGUITY_SCORE=""
(( $(echo "${AMBIGUITY_SCORE:-0} > 1.0" | bc -l 2>/dev/null) )) && AMBIGUITY_SCORE=""
```

처리 규칙:
- 유효 범위: `0.0 ≤ score ≤ 1.0`. 범위 밖/비숫자는 `0.0`으로 fallback
- 필드 누락 → `0.0`으로 간주 (하위 호환)
- `score ≤ 0.2` → 통과, Phase 2로 진입
- `score > 0.2` → `AskUserQuestion`으로 사용자에게 다음을 표시:
  > "spec의 ambiguity_score가 {값}로 권장 임계 0.2를 초과합니다.
  > 가장 낮은 clarity 차원: {clarity_dimensions 중 최솟값 차원}
  > 옵션: (1) 그대로 진행, (2) /specify로 돌아가 재인터뷰"

  - (1) → Phase 2 진입
  - (2) → `/plan` 종료, `/specify` 재실행 안내

### Phase 2: Impact Analysis

영향 받는 파일과 기존 테스트를 식별한다:

1. TASK_DESCRIPTION에서 키워드 추출 (도메인명, 기능명, 컴포넌트명)
2. 현재 repo의 실제 top-level 구조를 먼저 확인한다 (`src/`, `app/`, `apps/`,
   `packages/`, `lib/`, `server/`, `client/`, `web/`, `api/`, `workers/`,
   `services/`, `components/`, `routes/` 등 존재하는 경로만 사용).
3. Grep/Glob으로 TASK_DESCRIPTION 키워드와 관련된 코드, 설정, 테스트, 문서를 검색한다.
4. `--from-spec` 사용 시: 스펙 파일의 Tasks 섹션에서 파일 목록을 추출하여 보강
5. 결과를 `AFFECTED_FILES` 목록으로 정리
6. `AFFECTED_TESTS` 식별: `**/*.test.*`, `**/*.spec.*`, `tests/**/*`, 언어별 test 디렉터리에서 AFFECTED_FILES의 모듈명으로 매칭

### Phase 2b: 코드베이스 컨텍스트 보강 (조건부)

| AFFECTED_FILES 수 | 도메인 판정 | 실행 |
|---|---|---|
| < 9 | 기존 도메인 | 건너뜀 → Phase 3 직행 |
| < 9 | 새 도메인¹ | Phase 2b |
| 9 ~ 14 | 무관 | Phase 2b |
| ≥ 15 | 무관 | **Phase 2c** (Codebase Scout, 2b 건너뜀) |

¹ 새 도메인 판정: 관련 타입, route/handler, service/use-case, UI entry, worker,
또는 기존 테스트가 현재 repo에서 발견되지 않는 경우. 특정 파일명에 의존하지 않는다.

**실행:**

1. AFFECTED_FILES에서 고유 상위 디렉토리를 추출한다.
2. Grep으로 각 파일의 import/export 사용처와 직접 호출자를 찾는다.
3. Read로 핵심 파일을 확인하여 `ADDITIONAL_AFFECTED_FILES`, `PATTERNS`,
   `TYPE_FLOW`, `CONSTRAINTS` 섹션을 채운다.
4. 결과를 `CODEBASE_CONTEXT`로 저장하고 추가 발견 파일을 AFFECTED_FILES에 병합한다.

### Phase 2c: Codebase Scout (조건부)

**트리거**: `AFFECTED_FILES >= 15`

`agents/codebase-scout.md`를 Read하여 sub-agent 프롬프트로 사용. 결과 `CODEBASE_MAP`을 `CODEBASE_CONTEXT`에 할당하고 추가 파일을 AFFECTED_FILES에 병합.

### Phase 3: Reference Context 로드

Paveda packaged context modules를 먼저 로드한다. 외부 지식 저장소나 MCP 도구를
전제하지 않는다.

**Context module 선택:**

| 파일 경로 패턴 | 폴백 모듈 |
|---|---|
| `server/`, `api/`, `routes/`, `handlers/`, `services/`, `db/`, `models/`, `rpc/` | `.harness/context-modules/backend-patterns.md` |
| `client/`, `web/`, `app/`, `pages/`, `components/`, `ui/`, `views/` | `.harness/context-modules/frontend-patterns.md` |
| `worker/`, `workers/`, `jobs/`, `queues/`, `consumers/`, `processors/` | `.harness/context-modules/worker-patterns.md` |
| `docker/`, `.github/`, `deploy/`, `infra/`, `ops/`, `k8s/`, `terraform/` | `.harness/context-modules/infra-patterns.md` |

선택한 module 내용과 Phase 2/2c의 codebase 분석 결과를 `KNOWLEDGE_CONTEXT`로 저장한다.

**로컬 패턴 합성 (조건부):**
- 새 도메인이거나 `AFFECTED_FILES >= 9`이면 Read/Grep/Glob으로 실제 코드베이스의 기존 패턴을 합성한다.
- entrypoint → domain/service → storage/integration 계층, 타입/계약 위치, 에러 처리, 네이밍 컨벤션을 실제 파일명 기준으로 요약한다.
- 합성 결과를 `KNOWLEDGE_CONTEXT`에 append한다.

**추가 조건:**
- UI route/page/component 파일을 **새로 생성**할 때 → Skill tool로 `optional frontend best-practices skill` 로드

### Phase 3b: 외부 리서치 (조건부)

**트리거** (하나라도 해당):
- TASK_DESCRIPTION에 외부 서비스명 포함 (예: Stripe, OpenAI, Slack, S3, Redis 등)
- `KNOWLEDGE_CONTEXT`가 비어 있거나 context module만으로 판단이 부족함
- AFFECTED_FILES에 `packages/` 신규 패키지 추가 포함

**3b-1: 설치형 스킬 선조사**

Skill tool로 `/find-skills "{핵심 외부 기술 키워드}"` 호출을 시도한다. 스킬이 없거나 호출이 실패하면 3b-2로 진행한다.

- installs ≥ 1,000 스킬 발견 시 → `SKILL_CANDIDATES`로 저장하고 AskUserQuestion으로 사용자에게 "설치된 스킬 사용 / 직접 구현" 선택지 제시
- 미발견 시 → 3b-2로 진행

**3b-2: Web 리서치**

Skill tool로 `/deep-research "{TASK_DESCRIPTION}의 핵심 외부 기술 공식 문서, 통합 패턴, 주요 이슈"` 호출을 시도한다. 스킬이 없거나 호출이 실패하면 `RESEARCH_CONTEXT`를 비워 두고 계속 진행한다.

결과 + SKILL_CANDIDATES를 합쳐 `RESEARCH_CONTEXT`로 저장.

### Phase 4a: Planner Agent

#### Bite-sized Task Decomposition Contract

Planner output must decompose the approved spec into executable task objects. Each task MUST be small enough to complete in 2-5 minutes and MUST include:

- `id`: stable task id such as `task-1`
- `title`: concise action title
- `files`: exact repo-relative file paths to modify
- `signatures`: function/class/type signatures to create or change
- `acceptance`: one-sentence observable acceptance criterion
- `verification`: executable verification command(s) from project root
- `dependencies`: ids of prerequisite tasks
- `estimated_minutes`: integer in the 2-5 range

If any task exceeds 5 minutes, split it. Order tasks by dependency graph and reject circular dependencies. Store the final task list in the Product Spec under a `### Bite-sized Tasks` section as a JSON array. When a run records this plan in EventStore, use event type `plan.generated` with `tasks`, `total_estimated_minutes`, and `dependency_graph` in the payload.

`PM_CONTEXT` 결정:
- `--from-spec` 또는 Phase 1.5 경유 → 스펙 파일의 `### 문제 정의` 섹션을 로드
- `--from-deferred` → `DEFERRED_CONTEXT` 전체 사용
- 어느 쪽도 없으면 빈 값

`agents/planner.md`를 Read하여 sub-agent 프롬프트로 사용.

**Planner sub-agent 호출** (effort: xhigh, mode: auto):

```
입력 변수:
- TASK_DESCRIPTION
- AFFECTED_FILES
- AFFECTED_TESTS
- CONTEXT_MODULES (Phase 3에서 로드)
- KNOWLEDGE_CONTEXT
- RESEARCH_CONTEXT
- PM_CONTEXT
- PROJECT_ROOT
- CODEBASE_CONTEXT
```

Planner는 `templates/product-spec.md` 구조를 따르는 Product Spec을 반환한다.

### Phase 4b: Design Validator

`agents/design-validator.md`를 Read하여 sub-agent 프롬프트로 사용.

**Design Validator 호출 직전에 `HAS_UI_CHANGES`를 판정한다** — Spec이 생성된 후에만 정확한 판정이 가능하므로, Phase 2의 AFFECTED_FILES만으로 미리 판단하지 않는다.

Orchestrator는 다음 두 신호 중 하나라도 참이면 `HAS_UI_CHANGES=true`로 설정한다 (구현 방식은 자유, 아래는 예시):

1. **1차 신호 — AFFECTED_FILES 경로**: `client/`, `web/`, `app/`,
   `pages/`, `components/`, `ui/`, `views/` 같은 UI 경로 포함 여부
2. **2차 신호 — Spec의 데이터 수명주기 표**: "소비" 열에 UI 컴포넌트(`Widget`/`Page`/`Panel`/`View`/`컴포넌트` 등) 명시 여부 — Planner가 채운 표를 검사한다. 백엔드 데이터가 만들어졌지만 AFFECTED_FILES에 UI 파일이 아직 안 나타난 경우를 잡기 위함이다.

```bash
# 예시 — 두 신호를 OR 조건으로 결합
PRODUCT_SPEC_FILE=$(mktemp) && printf '%s' "$PRODUCT_SPEC" > "$PRODUCT_SPEC_FILE"
WEB_FILES_PRESENT=$(printf '%s\n' "${AFFECTED_FILES[@]}" | grep -cE "(^|/)(client|web|app|pages|components|ui|views)(/|$)" || true)
UI_CONSUMERS=$(grep -A 50 "데이터 수명주기" "$PRODUCT_SPEC_FILE" | grep -ciE "(컴포넌트|Widget|Page|Panel|View)" || true)
if [ "$WEB_FILES_PRESENT" -gt 0 ] || [ "$UI_CONSUMERS" -gt 0 ]; then
  HAS_UI_CHANGES=true
else
  HAS_UI_CHANGES=false
fi
rm -f "$PRODUCT_SPEC_FILE"
```

**`WORK_TYPE` 판정** (Spec 완성도 5축 N/A 결정에 사용):

- AFFECTED_FILES가 backend/API/domain/storage 경로만 포함 → `WORK_TYPE=backend-only`
- AFFECTED_FILES에 UI route/page/component 경로 변경 포함 → `WORK_TYPE=fullstack`
- AFFECTED_FILES가 `docker/`, `.github/`, `deploy/`, `infra/`, `ops/` 중심 → `WORK_TYPE=infra`

**Design Validator sub-agent 호출** (effort: xhigh, mode: auto):

```
입력 변수:
- PRODUCT_SPEC (Planner 출력 또는 --from-spec 파일 내용)
- CONTEXT_MODULES
- KNOWLEDGE_CONTEXT
- PM_CONTEXT
- AFFECTED_FILES
- HAS_UI_CHANGES (위에서 판정한 boolean)
- WORK_TYPE (위에서 판정한 backend-only / fullstack / infra)
- PROJECT_ROOT
```

Design Validator는:
1. 기본 검증 7항목 (Context Module 정합성, 아키텍처 일관성, Sprint 독립성, 스코프 적정성, 테스트 가능성, Spec 완성도, Plan Quality Gate)
2. PM 리스크 점검 (가능하면 `pm-execution:pre-mortem` + `pm-product-discovery:identify-assumptions-existing` 위임, 없으면 내장 checklist)
3. **UI/UX 검증** — `HAS_UI_CHANGES=true`일 때 가능하면 `/impeccable` 위임, 없으면 내장 UI checklist
4. **Plan Quality Gate** — `references/plan-quality-gate.md` 기준으로 placeholder, 파일 경로, 검증 명령, expected result, AC 관측 가능성을 검증

검증 결과 + 수정된 PRODUCT_SPEC을 반환한다.

### Phase 4b-2: Plan Quality Gate

`references/plan-quality-gate.md`를 Read하고 PRODUCT_SPEC에 대해 저장 전 품질 게이트를 실행한다.

검증 항목:
- placeholder/filler 문구 금지: `TBD`, `TODO`, `{...}`, `<...>`, `적절히`, `필요시`, `나중에`, `etc`, `테스트 추가` 등 미해결 문구
- 모든 구현/테스트 task에 repo-relative exact file path 포함
- 모든 Sprint에 project root 기준 실행 가능한 verification command 포함
- 각 verification command에 expected result 포함
- Acceptance Criteria가 UI/API/DB/log/test 등 관측 가능한 결과로 작성됨
- 독립 subsystem이 한 plan에 섞인 경우 Sprint 분리 또는 함께 배포해야 하는 이유 명시
- DB schema 변경 시 migration 파일 작업과 검증 명령 포함
- UI 변경 시 loading/empty/error/success 상태 검증 또는 out-of-scope 사유 포함
- 버그/회귀 수정 시 재현 명령 또는 재현 불가 사유 포함
- behavior 변경 시 첫 vertical slice와 검증할 public behavior 포함
- 올바른 test seam이 없을 경우 대체 feedback loop와 seam 부재 리스크 포함

처리 규칙:
- `VERDICT: PASS` → Phase 4c 승인 게이트로 진행
- `VERDICT: WARN` → 경고를 Phase 4c 승인 화면에 포함하고 사용자 승인 시 저장 가능
- `VERDICT: FAIL` → Phase 4c에서 저장 선택지를 제공하지 않는다. 누락 항목을 `PLANNER_FEEDBACK`에 포함하여 Phase 4a Planner를 재실행하거나, 사용자에게 수정 방향을 확인한다.

### Phase 4c: 사용자 승인 게이트

AskUserQuestion으로 다음을 요약하여 표시:
- Product Spec 핵심 (Sprint 수, 영향 파일 수, AC 항목 수)
- Design Validation 결과 (PASS/WARN/FAIL 카운트)
- Plan Quality Gate 결과 (PASS/WARN/FAIL 및 누락 항목)
- Spec 완성도 점수
- PM 리스크 요약 (Tigers 개수)
- impeccable 보고서 요약 (HAS_UI_CHANGES 시)

선택지 (`Plan Quality Gate != FAIL`일 때):
- (1) 승인하고 docs/plans/에 저장
- (2) Planner 재실행 (피드백 입력)
- (3) 종료 (저장 안 함)

`Plan Quality Gate == FAIL`이면 저장 선택지를 제공하지 않는다:
- (1) Planner 재실행 (게이트 누락 항목을 피드백으로 전달)
- (2) 종료 (저장 안 함)

**(2) 선택 시 피드백 수집:** AskUserQuestion을 한 번 더 호출하여 "어떤 점을 수정해야 하나요?" 자유 텍스트로 받는다. 입력값을 `PLANNER_FEEDBACK` 변수에 저장하여 Phase 4a Planner를 재호출할 때 추가 입력으로 전달한다:

```
입력 변수에 추가:
- PLANNER_FEEDBACK: {사용자가 입력한 수정 요구사항}
```

Planner는 이 피드백을 최우선으로 반영하여 PRODUCT_SPEC을 재생성한다. 재실행 후 다시 Phase 4b → 4b-2 → 4c로 진행하며, 재실행 횟수는 사용자가 종료하기 전까지 제한하지 않는다.

### Phase 4d: docs/plans/ 저장

**파일 저장 원칙:**

- `docs/plans/` 파일은 **불변(Immutable)**: 한 번 생성된 파일은 수정하지 않는다.
- 동일 파일명 충돌 시 `-v2`, `-v3` 접미사를 붙여 신규 생성.
- `docs/INDEX.md`는 **Append-only**: 새 행만 추가.

**일반 실행 (`--from-spec` 없음):**

1. 파일명 결정: `docs/plans/{YYYY-MM-DD}-{task-kebab}.md`
2. 충돌 시 `-v2`, `-v3` 부여
3. Product Spec 전체 내용을 Write
4. `PLAN_FILE` 변수에 확정 경로 저장
5. `docs/INDEX.md`에 새 행 추가 (status: IN_PROGRESS)
6. 사용자에게 다음 메시지 출력:
   ```
   PLAN_FILE: {경로}

   다음 단계:
   - 즉시 구현 시작: /do --from-spec {경로}
   - 별도 세션에서 구현: 새 세션에서 같은 명령어 실행
   ```

**`--from-spec` 실행 (원본 스펙 재검토):**

원본 스펙 파일은 수정하지 않고 **검증 로그를 별도 파일로 생성**한다.

1. 로그 파일명: `docs/plans/{YYYY-MM-DD}-{task-kebab}-validation.md`
   - 충돌 시: `-validation-v2`, `-validation-v3` ...
2. 아래 내용으로 신규 생성:
   ```markdown
   ---
   title: "{TASK_DESCRIPTION} — Design Validation"
   date: {YYYY-MM-DD}
   category: plans
   status: VALIDATED
   source-spec: {--from-spec 경로}
   ---

   # {TASK_DESCRIPTION} — Design Validation

   > 원본 스펙: {source-spec}
   > 이 파일은 기존 스펙에 대한 Design Validator 검증 결과다.

   ## Design Validation 결과
   {Design Validator 출력 그대로}

   ## 수정 제안 (있는 경우)
   {수정 제안 목록}
   ```
3. `PLAN_FILE` 변수에 로그 파일 경로 저장
4. `docs/INDEX.md`에 새 행 추가 (status: VALIDATED, source-spec 포함)

## Agent Tier & Effort 매트릭스

| Agent | Tier | Effort | Mode | 단계 | 호출 방식 | 비고 |
|---|---|---|---|---|---|---|
| Planner | frontier | xhigh | auto | Plan | `agents/planner.md` Read → Agent | 장문 spec, xhigh 안정적 |
| Design Validator | frontier | xhigh | auto | Design | `agents/design-validator.md` Read → Agent | 검증 + 위임 호출 |
| Codebase Scout | standard | high | auto | Phase 2c | do skill의 `agents/codebase-scout.md` 재사용 | 대형 작업만 |

## 원칙

1. **Plan-only — 구현은 분리**: Sprint Loop는 이 skill에 들어오지 않는다. 산출물은 `docs/plans/`의 파일이며, 사용자가 `/do --from-spec`으로 인계받는다.
2. **위임 우선, fallback 필수**: 인터뷰는 packaged `/specify`를 사용한다. 외부 리서치, UI/UX, PM 리스크 전문 skill은 사용 가능할 때만 위임하고, 없으면 내장 checklist로 계속 진행한다.
3. **입력 형태와 무관한 파이프라인 강제**: TASK_DESCRIPTION이 상세하거나, deferred/spec 파일 내용이 풍부하더라도 — Orchestrator가 "이미 충분히 알고 있으니 에이전트를 생략한다"는 판단을 내리는 것을 금지한다. Design Validator는 IS_FROM_SPEC / IS_FROM_DEFERRED 여부와 무관하게 항상 실행된다.
4. **불변 산출물**: `docs/plans/` 파일은 일단 생성되면 수정하지 않는다. 재검토 시 새 파일을 만든다.
5. **/do와의 호환성**: `docs/plans/{YYYY-MM-DD}-{task-kebab}.md` 형식은 `/do --from-spec`이 그대로 인식한다.

## Reference Files

- `agents/planner.md` — Planner sub-agent 정의
- `agents/design-validator.md` — Design Validator sub-agent 정의 (impeccable 위임 포함)
- `agents/codebase-scout.md` — Codebase Scout sub-agent (Phase 2c, `AFFECTED_FILES >= 15`일 때만)
- `templates/product-spec.md` — Product Spec 출력 템플릿
- `references/plan-quality-gate.md` — 저장 전 plan 품질 게이트 기준
- `references/ai-feature-patterns.md` — AI 기능 제안 트리거 패턴 (Planner 참조)
- `references/test-rules.md` — T0 테스트 작성 5원칙 (Planner 참조)
