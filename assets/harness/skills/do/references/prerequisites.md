# /do 스킬 사전 요구사항

`/do` PDCA 파이프라인이 선택적으로 연동할 수 있는 외부 도구 및 스킬 목록.

## 의존성 테이블

| 도구 / 스킬 | 역할 | 필수 여부 | 확인 방법 |
|------------|------|----------|----------|
| `PAVEDA_CODE_REVIEW_COMMAND` | Phase 5e Review Gate | 선택 (미설정 시 N/A) | `test -n "$PAVEDA_CODE_REVIEW_COMMAND"` |
| `PAVEDA_ADVERSARIAL_REVIEW_COMMAND` | Phase 6c Adversarial Review Gate | 선택 (미설정 시 N/A) | `test -n "$PAVEDA_ADVERSARIAL_REVIEW_COMMAND"` |
| `impeccable` 스킬 | Design Validator Step 2 UI/UX 검증 보강 | 선택 | 없으면 내장 UI checklist 사용 |
| `pm-execution:pre-mortem` | Design Validator Step 1.5 PM 리스크 보강 | 선택 | 없으면 내장 PM risk checklist 사용 |
| `pm-product-discovery:identify-assumptions-existing` | Design Validator Step 1.5 PM 가정 검증 보강 | 선택 | 없으면 내장 assumption checklist 사용 |

## 파이프라인별 사용 매트릭스

| Phase | 사용 도구 | 조건 |
|-------|----------|------|
| Phase 2b | Read/Grep/Glob 기반 코드베이스 컨텍스트 보강 | `9 ≤ AFFECTED_FILES < 15` |
| Phase 2c | Codebase Scout 서브에이전트 | `AFFECTED_FILES ≥ 15` |
| Phase 4b Design Validator | `impeccable:harden/clarify/critique` | `HAS_UI_CHANGES == true`이고 스킬이 있을 때 |
| Phase 4b Design Validator | `pm-execution:pre-mortem` | 스킬이 있을 때 |
| Phase 4b Design Validator | `pm-product-discovery:identify-assumptions-existing` | 스킬이 있을 때 |
| Phase 5e | `PAVEDA_CODE_REVIEW_COMMAND` | 설정된 경우 |
| Phase 6c | `PAVEDA_ADVERSARIAL_REVIEW_COMMAND` | 설정된 경우 |

## 도구 가용성 확인 스크립트

```bash
echo "=== /do prerequisites check ==="

# external review commands
test -n "${PAVEDA_CODE_REVIEW_COMMAND:-}" \
  && echo "✓ PAVEDA_CODE_REVIEW_COMMAND" \
  || echo "○ PAVEDA_CODE_REVIEW_COMMAND not configured (Review Gate N/A)"

test -n "${PAVEDA_ADVERSARIAL_REVIEW_COMMAND:-}" \
  && echo "✓ PAVEDA_ADVERSARIAL_REVIEW_COMMAND" \
  || echo "○ PAVEDA_ADVERSARIAL_REVIEW_COMMAND not configured (Adversarial Review N/A)"

echo "=== done ==="
```
