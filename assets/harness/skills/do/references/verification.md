# Agent B: Verification Checklist

Agent B는 구현 계획 대비 실제 구현의 정합성을 검증한다.
아래 6개 항목을 순서대로 검증하고, 각 항목에 PASS/FAIL + 근거를 기록한다.

## 검증 항목

### 1. 완전성 (Completeness)
계획의 모든 태스크가 구현되었는가?

- 계획의 T0~T4 각 체크리스트 항목을 하나씩 대조
- 구현되지 않은 항목이 있으면 FAIL + 누락 항목 명시
- "해당 없음"으로 건너뛴 항목은 건너뛴 이유가 타당한지 확인

### 2. 정합성 (Consistency)
타입, public interface, storage/schema가 레이어 간 일치하는가?

- shared type/model 정의와 entrypoint/consumer 사용처 비교
- interface input/output 스키마와 실제 handler/adapter 반환값 비교
- persistence query의 필드명과 타입 정의 비교
- **schema/model에 새 필드/테이블/컬렉션 추가 시 대응하는 migration 또는 equivalent persistence update 존재 여부 확인** — 누락 시 FAIL
- 불일치 발견 시 FAIL + 구체적 불일치 위치 명시

### 3. 테스트 커버리지 (Test Coverage)
변경된 로직에 대한 테스트가 존재하는가?

- 새로 추가된 함수/엔드포인트에 테스트가 있는지 확인
- 변경된 기존 함수의 테스트가 업데이트되었는지 확인
- AFFECTED_TESTS에 포함된 테스트가 모두 통과하는지 확인
- 커버리지 부족 시 FAIL + 누락된 테스트 케이스 명시

### 4. 스코프 준수 (Scope Adherence)
계획에 없는 변경이 포함되어 있지 않은가?

- `git diff --stat HEAD`의 변경 파일 목록과 계획의 AFFECTED_FILES 비교
- 계획에 없는 파일이 변경되었으면 변경 이유 검토
  - 사이드이펙트 대응 → 허용 (단, 테스트 포함 여부 확인)
  - 불필요한 리팩토링/개선 → FAIL
- import 정리, 타입 수정 등 필연적 변경은 허용

### 5. 코드 품질 / AI Slop 탐지
AI가 흔히 만드는 불필요한 코드 패턴이 있는가?

아래 패턴이 발견되면 FAIL:

| 패턴 | 설명 | 예시 |
|------|------|------|
| 불필요한 추상화 | 한 번만 쓰이는 helper/wrapper | `createSessionHelper()` that just calls `db.insert()` |
| 과도한 에러 처리 | 발생 불가능한 에러에 대한 방어 코드 | 내부 함수 호출에 try-catch |
| 환각 API | 존재하지 않는 라이브러리 함수 호출 | `client.records.bulkUpsert()` (실제 SDK에 없는 메서드) |
| 요청 외 기능 | 계획에 없는 추가 기능 구현 | 요청은 조회인데 삭제 기능도 추가 |
| 과도한 주석 | 코드를 그대로 설명하는 주석 | `// increment counter` above `counter++` |
| 불필요한 타입 단언 | 추론 가능한 곳에 `as Type` 사용 | `const x = 1 as number` |

### 6. 완료 기준 충족 (Acceptance Criteria)
계획의 "완료 기준" 섹션의 모든 항목이 충족되었는가?

- 각 완료 기준을 하나씩 검증
- 충족되지 않은 기준이 있으면 FAIL + 미충족 항목 명시
- 완료 기준이 모호한 경우, 구현이 합리적으로 충족하는지 판단

### 7. 사용자 가시성 (User Visibility)
새로 생성된 데이터가 최종 사용자에게 도달하는가?

- Product Spec의 데이터 수명주기 표에서 "소비(Consume)" 열이 채워진 항목 확인
- interface response에 포함된 새 필드가 실제 최종 소비자에서 사용되는지 확인
  - 해당 필드를 사용하는 UI component/view, worker, API client, or external adapter가 존재하는가 (Grep으로 검색)
  - 소비자가 존재하더라도 conditional path로 항상 숨겨지거나 실행되지 않는 것은 아닌가
- "소비자 미정"으로 Deferred된 데이터는 검증 대상에서 제외
- 데이터가 API까지 도달하지만 UI에 미표시 → FAIL + "dead data" 명시

### 8. 사용자 대면 텍스트 품질 (User-Facing Text Quality)
한국어 또는 다국어 문자열이 언어적으로 정확한가?

- 하드코딩된 한국어 문자열에서 조사 오류 검사 (이/가, 은/는, 을/를, 와/과)
  - 앞 글자의 종성(받침) 유무에 따라 올바른 조사가 사용되었는지 확인
- 문자열 연결(concatenation)로 생성되는 한국어 텍스트는 특히 주의
  - 동적으로 조합되는 문장에서 조사가 하드코딩되어 있으면 FAIL
  - 올바른 패턴: 종성 판별 함수로 런타임에 조사를 선택
- 맞춤법이 명백히 틀린 경우 FAIL
- 스타일/어투 차이는 PASS (주관적 판단 영역)

## 결과 형식

```
## Agent B 검증 결과

| # | 항목 | 결과 | 근거 |
|---|------|------|------|
| 1 | 완전성 | PASS/FAIL | ... |
| 2 | 정합성 | PASS/FAIL | ... |
| 3 | 테스트 커버리지 | PASS/FAIL | ... |
| 4 | 스코프 준수 | PASS/FAIL | ... |
| 5 | 코드 품질 | PASS/FAIL | ... |
| 6 | 완료 기준 | PASS/FAIL | ... |

**종합**: PASS / FAIL (N개 항목 실패)
```
