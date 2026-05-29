---
name: specify
description: "Feature specification skill. Runs a structured Socratic interview to crystallize vague feature ideas into Product Specs. Use when writing specs, requirements, or feature definitions. --quick mode for rapid PM context (used by /do). --discover adds PM opportunity analysis."
argument-hint: "[--quick] [--discover] <feature description>"
model: standard
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, AskUserQuestion, Skill, Agent
---

# /specify — Feature Specification

Socratic 인터뷰로 모호한 기능 아이디어를 Product Spec으로 결정화한다.
질문, 범위 결정, acceptance criteria, 검증 계획을 하나의 spec 산출물로 정리한다.

## Usage

```
/specify "add notification preferences page"    # 전체 인터뷰 + spec 작성
/specify --quick "refactor auth middleware"      # 빠른 PM 컨텍스트 (for /do)
/specify --discover "payment module"            # 인터뷰 + PM 기회 분석
```

## Execution Phases

---

### Phase 1: Argument Parsing

1. `$ARGUMENTS`에서 플래그 추출:
   - `--quick`: 빠른 PM 컨텍스트 모드 (최대 2Q, 파일 저장 없음, `/do` 파이프라인용)
   - `--discover`: PM opportunity analysis 추가
2. 나머지 텍스트 = FEATURE_DESCRIPTION
3. FEATURE_DESCRIPTION이 3단어 미만이면 `AskUserQuestion`으로 추가 설명 요청

---

### Phase 2: Context Loading

#### 2a: Reference Context 로드

Paveda packaged context modules를 우선 사용한다. 프로젝트에 host별로 렌더링된
context module이 있으면 그 경로를 Read하고, 없으면 packaged harness context
module을 fallback으로 사용한다.

결과는 `KNOWLEDGE_CONTEXT`로 저장한다. 외부 지식 저장소나 MCP 도구가 없어도
`/specify`는 계속 동작해야 한다.

#### 2b: Codebase Brownfield 감지

Glob으로 프로젝트 루트의 설정 파일 탐색:
- `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` → 존재하면 brownfield
- `.harness/AGENTS.md`, `ARCHITECTURE.md` → 존재하면 brownfield
- 없으면 greenfield

IS_BROWNFIELD = (위 파일 중 하나라도 존재하면 true)

#### 2c: 초기 영향 파일 식별

Grep/Glob으로 FEATURE_DESCRIPTION 키워드 기반 관련 코드 검색.
AFFECTED_FILES 목록 수집.

---

### Phase 3: Socratic Interview

> **`--quick` 모드**: Phase 3 전체를 단축 실행한다. 최대 2개 질문을 `AskUserQuestion`으로 질의 (목적/가치 1개 + 범위/제약 1개). 인터뷰 없이 바로 PM_CONTEXT 블록 생성 후 Phase 5로 이동.

#### 3a: 인터뷰어 역할 채택

인터뷰 루프 진입 전, 지연 도구 스키마를 로드한다:

```
ToolSearch(query: "select:AskUserQuestion,WebFetch")
```

`agents/socratic-interviewer.md`를 Read하여 역할 채택.
이 에이전트 파일은 별도 sub-agent로 스폰하지 않는다 — 메인 세션이 역할을 직접 수행한다.

IS_BROWNFIELD가 true이면: 코드 기반 답변 활성화 (PATH 1a/1b).

#### 3b: 상태 초기화

```
QUESTION_COUNT = 0           # 총 질문 수 (max cap: 8)
CONSECUTIVE_NON_USER = 0     # 연속 비사용자 답변 카운터
CLARITY_STREAK = 0           # ambiguity ≤ 0.2 연속 횟수 (종료 조건: 2)
AMBIGUITY_TRACKS = {
  goal: false,         # 해결됨?
  constraints: false,
  success_criteria: false,
  non_goals: false,
}
INTERVIEW_LOG = []           # 질문/답변 기록
```

#### 3c: 인터뷰 루프

각 라운드에서:

**1. 질문 생성**

현재까지 수집된 정보를 바탕으로 가장 큰 모호성을 타겟하는 질문 1개 생성.
`agents/breadth-keeper.md`를 내부적으로 참조하여 breadth 체크:
- 3라운드 이상 같은 트랙에서 반복 시 → 다른 트랙으로 zoom-out 질문
- AMBIGUITY_TRACKS의 미해결 트랙 우선 타겟

**2. PATH 라우팅**

질문 유형에 따라 PATH 결정:

| PATH | 조건 | 처리 방식 |
|------|------|----------|
| **1a** Auto-confirm | 설정 파일에서 명확한 사실 (언어, 프레임워크, 패키지 매니저) | 코드 Read 후 자동 확인, 사용자 알림 전용 |
| **1b** Code Confirm | 코드에서 추론 (명확하지 않은 패턴) | `AskUserQuestion` "I found X. Is this correct?" |
| **2** Human Judgment | 목표, 비전, 비즈니스 로직, 트레이드오프, 선호 | `AskUserQuestion` 직접 질의 |
| **3** Code + Judgment | 코드 사실 + 판단 모두 필요 | 코드 Read 후 사용자에게 결정 질의 |
| **4** Research | 외부 API, 라이브러리, 업계 표준 | WebFetch 후 `AskUserQuestion` 확인 |

**의심스러우면 PATH 2 사용** — 자동화보다 사용자 판단이 안전하다.

**Dialectic Rhythm Guard**:
- PATH 1a, 1b, 4 → CONSECUTIVE_NON_USER += 1
- PATH 2, 3 → CONSECUTIVE_NON_USER = 0
- CONSECUTIVE_NON_USER ≥ 3 이면 다음 질문은 반드시 PATH 2로 강제

**3. 답변 처리**

```
INTERVIEW_LOG.append({ question, path, answer, prefix })
QUESTION_COUNT += 1
```

prefix 규칙:
- PATH 1a/1b → `[from-code]`
- PATH 2/3 → `[from-user]`
- PATH 4 → `[from-research]`

**4. Ambiguity 자가평가**

매 라운드 후 내부 평가 (사용자에게 표시 안 함):

> 이 채점은 결정적이어야 한다 (temperature 0.1 등가 가이드라인 — 동일 입력에 동일 출력을 목표로 한다)

```
goal_clarity      = (목표가 구체적이고 측정 가능한가) 0.0~1.0
constraint_clarity = (기술적/범위/시간 제약이 명확한가) 0.0~1.0
criteria_clarity  = (검증 가능한 완료 조건이 있는가) 0.0~1.0
```

IS_BROWNFIELD가 false (Greenfield)이면 3차원 가중치를 사용한다:
```
clarity_score  = 0.4 × goal_clarity + 0.3 × constraint_clarity + 0.3 × criteria_clarity
ambiguity_score = 1.0 - clarity_score
```

IS_BROWNFIELD가 true (Brownfield)이면 4차원 가중치를 사용한다:
```
context_clarity = (기존 코드베이스 패턴/제약을 인터뷰가 충분히 다뤘는가) 0.0~1.0

clarity_score  = 0.35 × goal_clarity + 0.25 × constraint_clarity + 0.25 × criteria_clarity + 0.15 × context_clarity
ambiguity_score = 1.0 - clarity_score
```

lowest_dimension = 위 차원 중 clarity 값이 가장 낮은 차원 식별 (다음 라운드에 입력으로 전달)

- ambiguity_score ≤ 0.2 → CLARITY_STREAK += 1
- ambiguity_score > 0.2 → CLARITY_STREAK = 0

**5. 종료 조건 체크**

ambiguity_score > 0.2 이고 QUESTION_COUNT < 8 이면, 다음 라운드 질문은 **가장 낮은 clarity 차원(lowest_dimension)에 직접 묶여야 한다** (PATH 2 강제). 자가평가 단계 끝에서 식별된 lowest_dimension을 다음 라운드 Step 1 질문 생성에 입력으로 전달하여 부족 차원 강제 재질문을 수행한다.

다음 중 하나 해당 시 인터뷰 종료:
- `CLARITY_STREAK ≥ 2` (2회 연속 ambiguity ≤ 0.2)
- `QUESTION_COUNT ≥ 8` (최대 질문 수 도달)
- 사용자가 "done", "이걸로 충분", "스펙 써줘" 등 종료 신호

종료 직전, `agents/seed-closer.md`를 내부 참조:
- 남은 모호성이 실행에 영향 주는가?
- 영향 없으면 → 인터뷰 종료
- 영향 있으면 → 해당 트랙 1개만 추가 질의

**6. 루프 반복**

종료 조건 미달성 시 Step 1로 돌아간다.

---

### Phase 3.5: PM Discovery (`--discover` 플래그 시만)

Skill tool로 `/pm-product-discovery:discover "{FEATURE_DESCRIPTION}"` 호출을 시도한다.
스킬이 없거나 호출이 실패하면 아래 내장 PM checklist로 `PM_CONTEXT`를 작성한다:

- 대상 사용자와 사용 상황
- 해결하려는 문제
- 기대 가치
- 핵심 위험 또는 미검증 가정

---

### Phase 4: Spec 작성

인터뷰 결과를 `templates/product-spec.md` 구조로 변환한다.
템플릿은 `.harness/skills/do/templates/product-spec.md`에 있다.

#### 매핑 규칙

| 인터뷰 수집 데이터 | Product Spec 섹션 |
|------------------|------------------|
| 목표/가치 답변 | `### 문제 정의` |
| 기능 상세 답변 | `### 기능 명세` |
| 기술 제약/선택 | `### 기술 결정` |
| Success criteria | `### 완료 기준` |
| 명시적 비목표 | `### 스코프 외` |
| PM_CONTEXT (--discover) | `### 문제 정의` 상단 |

Sprint 분할 기준 (templates/product-spec.md 규칙 준수):
- AFFECTED_FILES < 5 → 단일 Sprint
- AFFECTED_FILES 5~8 → 2 Sprint
- AFFECTED_FILES ≥ 9 또는 새 도메인 → 3+ Sprint

---

### Phase 4.5: UX 검토 (프론트엔드 변경 시만)

**트리거 조건** (`--quick` 모드 제외):
- Spec의 기능 명세 또는 Tasks 섹션에서 UI route/page/component, 사용자 화면, 인터랙션이 언급된 경우

조건에 해당하면 작성된 Spec의 UI 설계 섹션을 대상으로 impeccable 스킬 3종 호출을 시도한다. 스킬이 없거나 호출이 실패하면 내장 UI checklist로 검토한다:

| 스킬 | 목적 |
|------|------|
| `impeccable:harden` | 에러 상태, 빈 상태, 로딩 상태가 스펙에 포함되었는지 검증 |
| `impeccable:clarify` | UX 문안(label, placeholder, tooltip, 오류 메시지)의 명확성 검토 |
| `impeccable:critique` | 시각적 계층, 사용자 흐름, 정보 구조 관점에서 설계 효과성 평가 |

각 스킬 호출 결과를 통합하여 Spec 파일에 `### UX 검토` 섹션으로 추가한다:

Fallback checklist:
- loading/empty/error/success 상태가 명시되어 있는가
- 주요 label, placeholder, tooltip, error copy가 모호하지 않은가
- 기존 화면 구조와 탐색 흐름을 깨지 않는가
- 키보드/스크린리더/반응형 고려가 빠지지 않았는가

```markdown
### UX 검토

| 항목 | 결과 | 피드백 |
|------|------|--------|
| 상태 견고성 (harden) | PASS/WARN | {피드백} |
| 문안 명확성 (clarify) | PASS/WARN | {피드백} |
| UX 효과성 (critique) | PASS/WARN | {피드백} |

{WARN 항목이 있는 경우 구체적 개선 제안}
```

WARN 항목의 개선 제안은 Spec의 해당 섹션(기능 명세, 완료 기준 등)에도 직접 반영한다.

---

### Phase 5: 출력

#### `--quick` 모드 출력 (파일 저장 없음)

표준 출력으로 PM_CONTEXT 블록만 반환 (Planner가 직접 소비):

```markdown
### PM_CONTEXT

**목적**: {한 줄 요약}
**사용자 가치**: {가치 설명}
**핵심 제약**: {주요 제약 1-3개}
**범위**: {포함/제외 경계}
**수락 조건 초안**: {검증 가능한 완료 기준 1-3개}
```

#### `--quick` 모드 출력과 frontmatter 작성

`--quick` 모드는 파일 저장이 없으므로 아래의 frontmatter 작성 단계도 자연 우회된다.

#### 일반 모드 출력 (파일 저장)

1. **파일명**: `docs/plans/{YYYY-MM-DD}-{feature-kebab}.md`
   - 동일 이름 존재 시 `-v2`, `-v3` 접미사
2. **Write로 저장** — spec 파일 frontmatter에 다음 필드를 포함한다:
   ```yaml
   ambiguity_score: 0.18         # 최종 라운드의 ambiguity_score (소수점 둘째 자리)
   is_brownfield: true           # IS_BROWNFIELD 값
   clarity_dimensions:
     goal: 0.85
     constraint: 0.75
     criteria: 0.80
     context: 0.70               # Brownfield 한정. Greenfield는 이 키 생략
   ```
3. **`docs/INDEX.md`** 에 새 행 추가 (status: draft)

저장 후 출력:
```
SPEC_PATH: docs/plans/{파일명}

📍 Spec 저장: docs/plans/{파일명}
📍 Next: /do --from-spec docs/plans/{파일명} 으로 구현 시작
```

첫 줄 `SPEC_PATH:` 는 `/do` Interview Gate가 경로를 파싱하기 위한 구조화된 계약 라인이다.
이후 `📍` 라인은 단독 `/specify` 사용 시의 사용자 가독성 출력이다.

---

## Design Principles

1. **인터뷰어는 메인 세션이 역할 채택** — sub-agent 스폰 없음, AskUserQuestion round-trip 유지
2. **Dialectic Rhythm Guard** — 3회 연속 자동 답변 후 강제 PATH 2로 사용자 참여 보장
3. **자가평가 ambiguity 종료** — 수학적 점수화, streak=2 필요, max=8 cap
4. **breadth-keeper/seed-closer는 체크리스트** — 매 라운드 내부 참조, 별도 에이전트 아님
5. **`--quick`은 `/do` 파이프라인 계약** — 파일 저장 없음, PM_CONTEXT 블록만 반환
