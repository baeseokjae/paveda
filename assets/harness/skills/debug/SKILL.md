---
name: debug
description: "일반 실패/오류의 원인을 먼저 규명하는 root-cause debugging flow. 테스트 실패, 로컬 오류, CI 실패 재현, 런타임 예외, 사용자가 '원인 파악 먼저'를 요청할 때 사용한다."
argument-hint: "<symptom or failing command>"
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion, Skill, Agent
---

# /debug — Root-Cause Debugging

일반 실패와 오류를 재현 → 증거 수집 → 단일 가설 → 최소 수정 → fresh verify 순서로 처리한다.
`/do`처럼 전체 구현 pipeline을 실행하지 않는다. 목적은 실패 원인을 구체적으로 밝히고, 필요한 경우 그 원인에 묶인 최소 수정만 수행하는 것이다.

공통 진단 계약은 이 skill의 재현 루프 우선 원칙을 따른다. 재현 가능한 feedback loop 또는 재현 불가 증거 없이는 가설 검증이나 코드 수정으로 넘어가지 않는다.

## Usage

```
/debug "project test command fails in feature.test.ts"
/debug "로컬에서 특정 화면 진입 시 500 발생 원인 파악"
/debug "CI e2e.yml 실패 로그 보고 원인부터 찾아줘"
```

## Execution Order

### Phase 1: 증상 수집

1. `$ARGUMENTS`에서 실패 증상, 명령, 파일 경로, 로그 단서를 추출한다.
2. 인자가 비어 있으면 어떤 명령 또는 증상을 디버깅할지 사용자에게 묻고 중단한다.
3. 사용자가 "수정하지 말고 원인만"이라고 했으면 `DIAGNOSIS_ONLY=true`로 설정한다.

### Phase 2: 재현

가능하면 사용자가 준 명령을 그대로 실행한다.

```bash
{failing command} 2>&1 | tail -120
```

명령이 없으면 증상에 맞는 가장 좁은 재현 명령을 결정한다:
- 특정 테스트 파일 → 해당 테스트만 실행
- 특정 패키지/워크스페이스 → 해당 package manager의 workspace/filter 명령 사용
- 브라우저/런타임 오류 → 관련 dev 서버, 로그, API endpoint를 먼저 확인

재현 루프 우선순위:
1. 실패하는 unit/integration test
2. 사용자가 준 failing command 또는 CI command
3. curl/HTTP script
4. Playwright/browser script
5. trace/log/HAR/request replay
6. throwaway harness
7. flaky 재현율을 높이는 반복/stress loop

비결정적 실패는 완전 재현보다 재현율 상승을 먼저 목표로 한다. 입력 고정, 반복 실행, timing window 축소, seed 고정, 로그 캡처로 디버깅 가능한 루프를 만든다.

재현 실패 시:
- "현재 환경에서 재현 실패"를 명시한다.
- 재현을 위해 필요한 입력, env, fixture, 서비스 상태를 구체적으로 나열한다.
- 원인을 추측해서 수정하지 않는다.
- 재현 루프를 만들기 위해 시도한 방법을 나열한다.

### Phase 3: 증거 수집

아래를 병렬로 확인한다. 독립 명령은 동시에 실행한다.

```bash
git status --short
git diff --stat
git diff
git log --oneline -5
```

추가로 실패 대상에 맞춰 확인한다:
- 에러 stack trace의 첫 repo-local frame
- 실패한 테스트 파일과 대상 구현 파일
- 최근 변경된 관련 파일
- 같은 패턴의 working example 또는 인접 테스트
- 설정/env/schema/migration mismatch 가능성

### Phase 4: 원인 가설

가설은 한 번에 하나만 세운다.

형식:

```markdown
## Root Cause Candidate

증거:
- {파일:라인 또는 명령 출력 요약}

가설:
- {코드/데이터/설정 수준의 구체 원인}

검증 방법:
- {이 가설이 맞는지 확인할 명령 또는 파일 확인}
```

금지:
- "추론 문제", "에이전트가 누락", "뭔가 꼬임" 같은 추상 원인
- 재현 없이 코드 수정
- 여러 가설을 동시에 수정
- 실패 원인과 무관한 리팩터링

원인 불명 시 "원인 불명"이라고 명시하고, 추가로 필요한 증거를 사용자에게 요청한다.

### Phase 5: 최소 수정 계획

가설이 검증되면 수정 범위를 제시한다:

```markdown
## Fix Plan

1. {파일}: {최소 수정}
   - verify: {명령}
   - expected: {기대 결과}
```

`DIAGNOSIS_ONLY=true`이면 여기서 멈추고 코드를 수정하지 않는다.
사용자가 이미 "해결", "진행", "고쳐줘"를 요청했거나 현재 요청이 명백한 fix 요청이면 바로 Phase 6으로 진행한다.

### Phase 6: 최소 수정

수정 원칙:
- 실패 원인에 직접 연결된 줄만 변경한다.
- 주변 정리, 스타일 변경, dead code 제거는 이번 수정 때문에 생긴 경우에만 수행한다.
- 기존 AGENTS.md와 context module 규칙을 따른다.
- schema 변경 시 migration 파일도 함께 다룬다.

### Phase 7: Fresh Verify

수정 후 같은 명령을 다시 실행한다.

```bash
{original failing command}
```

그 다음 영향 범위에 맞춰 추가 검증한다:
- 단일 테스트 실패 수정 → 해당 테스트 + 관련 package lint/typecheck
- API/DB 수정 → 관련 integration test + migration/schema check
- UI 수정 → 관련 test/build + 필요 시 browser validation
- 광역 수정 → `/verify`

### Phase 8: Report

최종 보고는 원인과 증거를 먼저 쓴다.

```markdown
## Root Cause
{구체 원인}

## Evidence
- {명령/파일/라인 기반 증거}

## Fix
- {변경 파일과 변경 요약}

## Verification
- `{명령}`: PASS/FAIL
```

## Principles

1. **Reproduce first**: 재현 또는 재현 불가 증거 없이 수정하지 않는다.
2. **Concrete causes only**: 원인은 코드/데이터/설정/환경 수준으로 명시한다.
3. **One hypothesis at a time**: 여러 추측을 한 번에 고치지 않는다.
4. **Minimal patch**: 실패 원인에 묶인 최소 변경만 한다.
5. **Fresh verify**: 수정 후 원래 실패 명령을 다시 실행한다.
6. **Correct seam only**: 실제 버그 패턴을 검증하지 못하는 얕은 회귀 테스트는 만들지 않는다. 올바른 test seam이 없으면 그 사실을 보고한다.
