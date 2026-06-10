# Test Design Rules for AI-Written Tests

AI가 작성하는 테스트는 "통과하기 위한 테스트"가 아니라 "스펙을 검증하는 테스트"여야 한다.
아래 5가지 원칙을 지키면 tautological test(구현을 앵무새처럼 반복하는 테스트)를 방지할 수 있다.

## 1. 테스트 하나에 행동 하나

하나의 테스트는 하나의 행동(behavior)만 검증한다.
여러 행동을 하나의 테스트에 넣으면 실패 원인을 특정하기 어렵다.

```ts
// ✅ Good — 하나의 행동
it("returns 401 when token is missing", async () => {
  const res = await request(app).get("/api/sessions");
  expect(res.status).toBe(401);
});

// ❌ Bad — 여러 행동을 한 테스트에
it("handles authentication", async () => {
  const res1 = await request(app).get("/api/sessions");
  expect(res1.status).toBe(401);
  const res2 = await request(app).get("/api/sessions").set("Authorization", token);
  expect(res2.status).toBe(200);
  expect(res2.body.sessions).toBeDefined();
});
```

## 2. 관측 가능한 출력만 검증

내부 구현(private 변수, 호출 횟수 등)이 아닌 외부에서 관측 가능한 결과를 검증한다.
구현이 바뀌어도 행동이 같으면 테스트는 통과해야 한다.

```ts
// ✅ Good — 결과를 검증
expect(await getSession(id)).toEqual({ id, title: "test", status: "active" });

// ❌ Bad — 내부 구현을 검증
expect(db.query).toHaveBeenCalledWith("SELECT * FROM sessions WHERE id = $1", [id]);
```

## 3. Mock은 I/O 경계에서만

Mock은 외부 시스템(DB, API, 파일시스템)과의 경계에서만 사용한다.
내부 함수를 mock하면 리팩토링 시 테스트가 깨진다.

**Mock 허용**: DB connection, HTTP client, file system, external API
**Mock 금지**: 같은 모듈의 다른 함수, utility 함수, 내부 상태

## 4. 스펙에서 테스트 도출, 구현에서 도출 금지

테스트는 "무엇을 해야 하는가"(스펙)에서 도출한다.
"어떻게 구현되었는가"(코드)를 보고 작성하면 구현의 버그를 그대로 테스트에 복제한다.

**테스트 작성 순서**:
1. 계획의 T0 항목에서 테스트 케이스 도출
2. 각 케이스의 입력/기대 출력 정의
3. 테스트 코드 작성
4. ← 이 시점에서 구현 코드를 보지 않는다

## 5. Edge Case 포함 필수

Happy path만으로는 부족하다. 최소한 아래 케이스를 포함:

- **빈 입력**: 빈 문자열, 빈 배열, null/undefined
- **경계값**: 0, 음수, 최대값, 빈 페이지
- **에러 경로**: 네트워크 실패, 권한 없음, 잘못된 형식
- **동시성**: 중복 요청, race condition (해당 시)

## 6. Vertical Slice TDD

테스트를 한 번에 대량 작성한 뒤 구현을 몰아서 하지 않는다. 하나의 behavior를 선택하고 다음 루프를 끝낸 뒤 다음 behavior로 넘어간다:

1. public interface 또는 실행 가능한 feedback loop 식별
2. behavior 하나를 검증하는 테스트 작성
3. 테스트 실행 후 RED 확인
4. 최소 구현으로 GREEN 달성
5. affected test 실행

이 루프는 Paveda `/do`의 공통 TDD 계약이다.

## 7. 올바른 Test Seam이 없을 때

실제 버그나 사용자 행동을 검증하지 못하는 얕은 테스트를 억지로 만들지 않는다.
올바른 seam이 없으면 가장 좁은 실행 루프를 검증 수단으로 사용하고, seam 부재를 리스크 또는 deferred 항목으로 기록한다.

## 8. Refactor는 GREEN 이후

테스트가 RED인 동안 구조 개선을 섞지 않는다. 모든 behavior check가 GREEN인 뒤에만 중복 제거, 모듈 심화, 이름 정리를 검토한다.

## 9. Paveda Gate Evidence

Paveda에서는 테스트 실행 결과를 ledger evidence로 남겨야 한다.

- 코드 변경(`code`, `ui`, `api`, `data`, `infra`, `test`, `mixed`)은 unit gate와 e2e/package-level gate를 통과해야 한다.
- 테스트 인프라가 없으면 구현을 계속하지 말고 최소 테스트 인프라를 추가하는 setup sprint 여부를 사용자에게 확인한다.
- 문서 또는 metadata/config 변경은 테스트 비대상 근거를 `not_applicable` evidence로 기록한다.
- `not_applicable` evidence에는 rationale, `metadata.classifierReason`, `metadata.userApproval` 또는 `metadata.approvedBy`가 필요하다.
- `skip`은 evidence result가 아니다.
