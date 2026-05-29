#!/usr/bin/env bash
# test-detect-stagnation-cross-sprint.sh — AT_CS1 ~ AT_CS7 테스트 러너
# Sprint 1 (D3) 검증: cross-sprint meta-stagnation detection
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CS="$SCRIPT_DIR/detect-stagnation-cross-sprint.sh"
FIXTURES="$SCRIPT_DIR/test-fixtures/iterator"
SKILL_MD="$SCRIPT_DIR/../SKILL.md"

PASS=0
FAIL=0

pass() {
  echo "PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "FAIL: $1"
  FAIL=$((FAIL + 1))
}

# fixture 기반 테스트 헬퍼
run_fixture_test() {
  local name="$1"
  local fixture="$2"
  local expected_file="$3"

  local actual exit_code=0
  actual=$(bash "$CS" "$fixture" 2>&1) || exit_code=$?

  if [ $exit_code -ne 0 ]; then
    fail "$name: 스크립트가 exit $exit_code 반환"
    echo "  출력: $actual"
    return
  fi

  local expected
  expected=$(cat "$expected_file")

  if jq -e --argjson exp "$expected" '$exp == .' <(echo "$actual") > /dev/null 2>&1; then
    pass "$name"
  else
    fail "$name: 출력 불일치"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

# --- AT_CS1: 2 sprint 동일 Spinning → meta_stagnation=false (임계값 3 미달) ---
run_fixture_test \
  "AT_CS1: 2 sprint 동일 Spinning 패턴 → meta_stagnation=false (임계값 3 미달)" \
  "$FIXTURES/cross-sprint-2-same-spin.jsonl" \
  "$FIXTURES/cross-sprint-2-same-spin.expected.json"

# --- AT_CS2: 2 sprint 다른 패턴 (Sprint1=Spinning, Sprint2=Oscillation) → false ---
run_fixture_test \
  "AT_CS2: 2 sprint 다른 패턴 (Spinning vs Oscillation) → meta_stagnation=false" \
  "$FIXTURES/cross-sprint-2-diff-patterns.jsonl" \
  "$FIXTURES/cross-sprint-2-diff-patterns.expected.json"

# --- AT_CS3: 1 sprint만 존재 → meta_stagnation=false ---
run_fixture_test \
  "AT_CS3: 1 sprint만 존재 → meta_stagnation=false" \
  "$FIXTURES/cross-sprint-1-sprint.jsonl" \
  "$FIXTURES/cross-sprint-1-sprint.expected.json"

# --- AT_CS4: 빈 파일 → meta_stagnation=false ---
run_fixture_test \
  "AT_CS4: 빈 파일 → meta_stagnation=false" \
  "$FIXTURES/cross-sprint-empty.jsonl" \
  "$FIXTURES/cross-sprint-empty.expected.json"

# --- AT_CS5: 3 sprint 동일 Spinning → meta_stagnation=true, pattern=Spinning, sprints=[1,2,3] ---
run_fixture_test \
  "AT_CS5: 3 sprint 동일 Spinning → meta_stagnation=true, pattern=Spinning, sprints=[1,2,3]" \
  "$FIXTURES/cross-sprint-meta-spin.jsonl" \
  "$FIXTURES/cross-sprint-meta-spin.expected.json"

# --- AT_CS6: SKILL.md Phase 5d 직후 detect-stagnation-cross-sprint.sh 호출 블록 존재 ---
if rg -q "detect-stagnation-cross-sprint\.sh" "$SKILL_MD"; then
  pass "AT_CS6: SKILL.md에 detect-stagnation-cross-sprint.sh 호출 블록 존재"
else
  fail "AT_CS6: SKILL.md에 detect-stagnation-cross-sprint.sh 호출 블록 없음"
fi

# --- AT_CS7: meta_stagnation=true 시 AskUserQuestion 트리거 코드 경로 존재 ---
# meta_stagnation 파싱과 AskUserQuestion이 60줄 이내에 함께 존재하는지 검증
AT_CS7_PASS=0
# meta_stagnation 라인 번호 목록 추출
META_LINES=$(rg -n "meta_stagnation" "$SKILL_MD" | awk -F: '{print $1}' | head -20)
if [ -z "$META_LINES" ]; then
  fail "AT_CS7: SKILL.md에 meta_stagnation 참조 없음"
else
  # 각 meta_stagnation 라인으로부터 ±30줄 창에 AskUserQuestion이 존재하는지 검사
  for mline in $META_LINES; do
    start=$((mline - 30))
    [ $start -lt 1 ] && start=1
    end=$((mline + 30))
    # 해당 창에서 AskUserQuestion 검색
    if sed -n "${start},${end}p" "$SKILL_MD" | rg -q "AskUserQuestion"; then
      AT_CS7_PASS=1
      break
    fi
  done
  if [ $AT_CS7_PASS -eq 1 ]; then
    pass "AT_CS7: meta_stagnation=true 시 AskUserQuestion 트리거 코드 경로 존재 (SKILL.md)"
  else
    fail "AT_CS7: meta_stagnation 참조로부터 30줄 이내에 AskUserQuestion 없음"
  fi
fi

# --- AT_CS8: Spinning(4 sprints) vs Diminishing(3 sprints) → Spinning이 우선 선택됨 ---
run_fixture_test \
  "AT_CS8: Spinning(4 sprints) > Diminishing(3 sprints) → pattern=Spinning, sprints=[1,2,3,4]" \
  "$FIXTURES/cross-sprint-multi-winner.jsonl" \
  "$FIXTURES/cross-sprint-multi-winner.expected.json"

# --- AT_CS9: 손상된 JSONL 입력 → exit 2 + error:"malformed_history" ---
AT_CS9_TMP=$(mktemp)
trap "rm -f '$AT_CS9_TMP'" EXIT
printf '{"sprint":1\n{"sprint":\n' > "$AT_CS9_TMP"
AT_CS9_EXIT=0
AT_CS9_OUT=$("$CS" "$AT_CS9_TMP" 2>/dev/null) || AT_CS9_EXIT=$?
if [ "$AT_CS9_EXIT" -ne 2 ]; then
  fail "AT_CS9: 손상된 JSONL에서 exit 2 기대, 실제 exit $AT_CS9_EXIT"
elif ! echo "$AT_CS9_OUT" | jq -e '.error == "malformed_history"' > /dev/null 2>&1; then
  fail "AT_CS9: 출력에 error:\"malformed_history\" 없음. 실제: $AT_CS9_OUT"
else
  pass "AT_CS9: 손상된 JSONL → exit 2 + error:\"malformed_history\""
fi

# --- AT_CS10: SKILL.md malformed_history 분기에 AskUserQuestion 바인딩 산문 존재 ---
if rg -q "malformed_history.*AskUserQuestion|AskUserQuestion.*malformed_history" "$SKILL_MD"; then
  pass "AT_CS10: SKILL.md malformed_history 분기에 AskUserQuestion 바인딩 산문 존재"
else
  fail "AT_CS10: SKILL.md malformed_history 분기에 AskUserQuestion 바인딩 산문 없음"
fi

# --- 최종 결과 ---
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
