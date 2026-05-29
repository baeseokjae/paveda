#!/usr/bin/env bash
# test-detect-stagnation.sh — Sprint 1 AT0~AT3 test runner
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="$SCRIPT_DIR/detect-stagnation.sh"
FIXTURES="$SCRIPT_DIR/test-fixtures/iterator"

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local fixture="$2"
  local expected="$3"

  local actual
  actual="$(bash "$DETECT" "$fixture" 2>&1)"
  local exit_code=$?

  if [ $exit_code -ne 0 ]; then
    echo "FAIL [$name]: detect-stagnation.sh exited with code $exit_code"
    echo "  output: $actual"
    FAIL=$((FAIL + 1))
    return
  fi

  # Compare via jq deep-equal
  if jq -e --argjson exp "$(cat "$expected")" '$exp == .' <(echo "$actual") > /dev/null 2>&1; then
    echo "PASS [$name]"
    PASS=$((PASS + 1))
  else
    echo "FAIL [$name]: output mismatch"
    echo "  expected: $(cat "$expected")"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# AT0: only-1-entry → empty result (early-iteration guard)
run_test "AT0: only-1-entry early guard" \
  "$FIXTURES/only-1-entry.jsonl" \
  "$FIXTURES/only-1-entry.expected.json"

# AT1a: spinning single pattern
run_test "AT1a: spinning" \
  "$FIXTURES/spinning.jsonl" \
  "$FIXTURES/spinning.expected.json"

# AT1b: oscillation single pattern
run_test "AT1b: oscillation" \
  "$FIXTURES/oscillation.jsonl" \
  "$FIXTURES/oscillation.expected.json"

# AT1c: no-drift single pattern
run_test "AT1c: no-drift" \
  "$FIXTURES/no-drift.jsonl" \
  "$FIXTURES/no-drift.expected.json"

# AT1d: diminishing single pattern
run_test "AT1d: diminishing" \
  "$FIXTURES/diminishing.jsonl" \
  "$FIXTURES/diminishing.expected.json"

# AT2: empty → empty result
run_test "AT2: empty fixture" \
  "$FIXTURES/empty.jsonl" \
  "$FIXTURES/empty.expected.json"

# AT3: multi-spin-nodrift → Spinning + No-Drift union + Contrarian
run_test "AT3: multi-spin-nodrift" \
  "$FIXTURES/multi-spin-nodrift.jsonl" \
  "$FIXTURES/multi-spin-nodrift.expected.json"

# AT_CROSS: cross-sprint isolation → sprint=1 has 3×hash_A (would spin), sprint=2 has 1 entry → early-iteration guard fires
run_test "AT_CROSS: cross-sprint isolation" \
  "$FIXTURES/cross-sprint-isolation.jsonl" \
  "$FIXTURES/cross-sprint-isolation.expected.json"

# AT_ADV1: large 10k entries — performance test, must complete within 30s with correct result
run_test_large() {
  local name="$1"
  local tmpfile
  tmpfile="$(mktemp /tmp/large-detect-XXXXXX.jsonl)"
  trap "rm -f '$tmpfile'" RETURN

  # Generate 10000 entries: sprint=1, all same hash → Spinning fires
  # match_rate increments by 1.0 per entry (delta >> 0.01) so No-Drift/Diminishing do NOT fire
  python3 -c '
import json, sys
for i in range(10000):
    obj = {
        "sprint": 1,
        "iteration": i + 1,
        "timestamp": "2026-05-11T10:00:00Z",
        "output_hash_normalized": "hash_A",
        "match_rate": 1.0 + i,
        "gap_fingerprint": "fp_1",
        "injected_personas": []
    }
    print(json.dumps(obj))
' > "$tmpfile"

  local expected
  expected='{"patterns":["Spinning"],"personas":["Contrarian","Hacker"]}'

  local actual
  local start_time end_time elapsed
  start_time=$(date +%s)
  actual="$(bash "$DETECT" "$tmpfile" 2>&1)"
  local exit_code=$?
  end_time=$(date +%s)
  elapsed=$((end_time - start_time))

  if [ $exit_code -ne 0 ]; then
    echo "FAIL [$name]: detect-stagnation.sh exited with code $exit_code (${elapsed}s)"
    echo "  output: $actual"
    FAIL=$((FAIL + 1))
    return
  fi

  if [ $elapsed -gt 30 ]; then
    echo "FAIL [$name]: exceeded 30s timeout (took ${elapsed}s)"
    FAIL=$((FAIL + 1))
    return
  fi

  if jq -e --argjson exp "$expected" '$exp == .' <(echo "$actual") > /dev/null 2>&1; then
    echo "PASS [$name] (${elapsed}s)"
    PASS=$((PASS + 1))
  else
    echo "FAIL [$name]: output mismatch (${elapsed}s)"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

run_test_large "AT_ADV1: large-10k performance"

# AT_ADV2: null match_rate → no No-Drift/Diminishing false positive
run_test "AT_ADV2: null-match-rate no false positive" \
  "$FIXTURES/null-match-rate.jsonl" \
  "$FIXTURES/null-match-rate.expected.json"

# AT_ADV3: missing output_hash_normalized → no false positive Spinning
run_test "AT_ADV3: missing-hash no false positive Spinning" \
  "$FIXTURES/missing-hash.jsonl" \
  "$FIXTURES/missing-hash.expected.json"

# AT_ADV4: string sprint values → numeric max used ("10" treated as 10, not lex max)
run_test "AT_ADV4: string-sprint numeric coercion" \
  "$FIXTURES/string-sprint.jsonl" \
  "$FIXTURES/string-sprint.expected.json"

fail() {
  echo "FAIL: $1"
  FAIL=$((FAIL + 1))
}

# AT4: 5 persona MD 존재 + frontmatter name 일치 + 본문 ≤ 6000 chars
PERSONAS_DIR="$SCRIPT_DIR/../personas/iterator"
for p in hacker researcher simplifier architect contrarian; do
  pf="$PERSONAS_DIR/$p.md"
  if [ ! -f "$pf" ]; then
    fail "AT4: missing $pf"
    continue
  fi
  name=$(awk '/^---/{n++; next} n==1 && /^name:/{print $2; exit}' "$pf" | tr -d '"')
  if [ "$name" != "$p" ]; then
    fail "AT4: frontmatter name mismatch in $pf (got: $name)"
    continue
  fi
  # 본문 크기: frontmatter 제거 후 char count (awk로 두 번째 --- 이후 출력)
  body_chars=$(awk '/^---/{n++; next} n>=2' "$pf" | wc -c)
  if [ "$body_chars" -gt 6000 ]; then
    fail "AT4: body of $pf exceeds 6000 chars ($body_chars)"
    continue
  fi
  echo "PASS [AT4: persona $p]"
  PASS=$((PASS + 1))
done

# AT5: SKILL.md Phase 5c-1에 detect-stagnation.sh 호출 라인 존재
SKILL_MD="$SCRIPT_DIR/../SKILL.md"
if rg -q "detect-stagnation\.sh" "$SKILL_MD"; then
  echo "PASS [AT5: detect-stagnation.sh in SKILL.md]"
  PASS=$((PASS + 1))
else
  fail "AT5: missing detect-stagnation.sh call in SKILL.md"
fi

# AT6: SKILL.md에 GAP_ANALYSIS prepend 로직 명시
if rg -q "GAP_ANALYSIS_AUGMENTED|GAP_ANALYSIS.*prepend|prepend.*GAP_ANALYSIS" "$SKILL_MD"; then
  echo "PASS [AT6: prepend logic in SKILL.md]"
  PASS=$((PASS + 1))
else
  fail "AT6: missing prepend logic in SKILL.md"
fi

# AT7: SKILL.md에 iterator-history.jsonl append + normalize 코드 블록 존재
AT7_FAIL=0
if ! rg -q "iterator-history\.jsonl" "$SKILL_MD"; then
  fail "AT7a: missing iterator-history.jsonl ref in SKILL.md"
  AT7_FAIL=1
fi
if ! rg -q "sha256sum|output_hash_normalized" "$SKILL_MD"; then
  fail "AT7b: missing hash normalize in SKILL.md"
  AT7_FAIL=1
fi
if [ "$AT7_FAIL" -eq 0 ]; then
  echo "PASS [AT7: iterator-history.jsonl append + normalize in SKILL.md]"
  PASS=$((PASS + 1))
fi

# AT8: SKILL.md fingerprint cutoff에 history 길이 가드 존재
if rg -q "history\.length|history_count|history_len|HISTORY_LEN" "$SKILL_MD"; then
  echo "PASS [AT8: history length guard on fingerprint cutoff in SKILL.md]"
  PASS=$((PASS + 1))
else
  fail "AT8: missing history length guard on fingerprint cutoff in SKILL.md"
fi

# AT9: SKILL.md Phase 5c-1에 retry cap이 진입 직후 명시 (모든 분기 공통 가드)
AT9_FAIL=0
# Step 0 블록에 RETRY_COUNT += 1과 cap 체크가 함께 존재해야 함
if ! rg -q "0\.\s+RETRY 진입 직후|0\. RETRY 진입|모든 분기 공통 가드" "$SKILL_MD"; then
  fail "AT9a: missing Step 0 common retry cap guard block in SKILL.md Phase 5c-1"
  AT9_FAIL=1
fi
if ! rg -q "RETRY_COUNT \+= 1" "$SKILL_MD"; then
  fail "AT9b: missing RETRY_COUNT += 1 in SKILL.md"
  AT9_FAIL=1
fi
# RETRY_COUNT > 4 는 정확히 1곳에만 존재해야 함 (중복 카운트 방지)
# GEN_RETRY_COUNT > 4 (Generator 전용)는 별도이므로 [^_]RETRY_COUNT 으로 Iterator 전용 라인만 계수
RETRY_CAP_COUNT=$(rg -c '[^_A-Z]RETRY_COUNT > 4' "$SKILL_MD" 2>/dev/null || echo 0)
if [ "$RETRY_CAP_COUNT" -ne 1 ]; then
  fail "AT9c: (non-GEN_)RETRY_COUNT > 4 must appear exactly once in SKILL.md (found: $RETRY_CAP_COUNT)"
  AT9_FAIL=1
fi
if [ "$AT9_FAIL" -eq 0 ]; then
  echo "PASS [AT9: common retry cap guard at top of Phase 5c-1 in SKILL.md]"
  PASS=$((PASS + 1))
fi

# AT10: SKILL.md에서 iterator-history.jsonl 참조가 ITERATOR_HISTORY_FILE 변수로 분리
AT10_FAIL=0
if ! rg -q "ITERATOR_HISTORY_FILE" "$SKILL_MD"; then
  fail "AT10: iterator-history.jsonl should use ITERATOR_HISTORY_FILE variable (separate from verification HISTORY_FILE)"
  AT10_FAIL=1
fi
HISTORY_FILE_ITER_COUNT=$(rg -c '^[^#]*HISTORY_FILE[^_].*=.*iterator-history' "$SKILL_MD" 2>/dev/null || echo 0)
if [ "$HISTORY_FILE_ITER_COUNT" -ne 0 ]; then
  fail "AT10: HISTORY_FILE should NOT be assigned iterator-history (use ITERATOR_HISTORY_FILE); found $HISTORY_FILE_ITER_COUNT occurrence(s)"
  AT10_FAIL=1
fi
if [ "$AT10_FAIL" -eq 0 ]; then
  echo "PASS [AT10: iterator-history.jsonl uses ITERATOR_HISTORY_FILE variable]"
  PASS=$((PASS + 1))
fi

# AT11: cap が RETRY_COUNT > 4 로 확장 (3회 일반 + 1회 persona 시도 budget)
if rg -q "RETRY_COUNT > 4" "$SKILL_MD"; then
  echo "PASS [AT11: retry cap is > 4 (3 normal + 1 persona attempt)]"
  PASS=$((PASS + 1))
else
  fail "AT11: retry cap should be > 4 (3 normal + 1 persona attempt)"
fi

# AT_CROSS_v2: detect-stagnation.sh --current-sprint 인자 동작
# (이전 sprint Spinning, 새 sprint 1 entry → --current-sprint 2 사용 시 빈 결과)
AT_CROSS_V2_TMP=$(mktemp)
trap "rm -f '$AT_CROSS_V2_TMP'" EXIT
cat > "$AT_CROSS_V2_TMP" <<'EOF'
{"sprint":1,"iteration":1,"output_hash_normalized":"hh","match_rate":80,"gap_fingerprint":"f","injected_personas":[]}
{"sprint":1,"iteration":2,"output_hash_normalized":"hh","match_rate":80,"gap_fingerprint":"f","injected_personas":[]}
{"sprint":1,"iteration":3,"output_hash_normalized":"hh","match_rate":80,"gap_fingerprint":"f","injected_personas":[]}
{"sprint":2,"iteration":1,"output_hash_normalized":"xx","match_rate":75,"gap_fingerprint":"g","injected_personas":[]}
EOF
AT_CROSS_V2_RESULT=$(bash "$DETECT" "$AT_CROSS_V2_TMP" --current-sprint 2 2>&1)
AT_CROSS_V2_EXIT=$?
EXPECTED_CROSS_V2='{"patterns":[],"personas":[]}'
if [ $AT_CROSS_V2_EXIT -ne 0 ]; then
  fail "AT_CROSS_v2: detect-stagnation.sh exited with code $AT_CROSS_V2_EXIT"
elif jq -e --argjson exp "$EXPECTED_CROSS_V2" '$exp == .' <(echo "$AT_CROSS_V2_RESULT") > /dev/null 2>&1; then
  echo "PASS [AT_CROSS_v2: --current-sprint 2 isolates from prior sprint stagnation]"
  PASS=$((PASS + 1))
else
  echo "FAIL [AT_CROSS_v2]: --current-sprint 2 should isolate from prior sprint stagnation"
  echo "  expected: $EXPECTED_CROSS_V2"
  echo "  actual:   $AT_CROSS_V2_RESULT"
  FAIL=$((FAIL + 1))
fi

GEN_FIXTURES="$SCRIPT_DIR/test-fixtures/generator"
GEN_PERSONAS_DIR="$SCRIPT_DIR/../personas/generator"

# ---------------------------------------------------------------------------
# GEN_AT1: Generator Spinning fixture → 호출 측 Spinning/Oscillation 필터 후 "Spinning" 포함
# ---------------------------------------------------------------------------
GEN_AT1_RESULT=$(bash "$DETECT" "$GEN_FIXTURES/generator-spinning.jsonl" 2>&1)
GEN_AT1_FILTERED=$(echo "$GEN_AT1_RESULT" | jq -c '.patterns | map(select(. == "Spinning" or . == "Oscillation"))' 2>/dev/null || echo '[]')
if echo "$GEN_AT1_FILTERED" | jq -e 'map(select(. == "Spinning")) | length >= 1' > /dev/null 2>&1; then
  echo "PASS [GEN_AT1: Generator Spinning fixture → filter yields Spinning]"
  PASS=$((PASS + 1))
else
  echo "FAIL [GEN_AT1]: expected Spinning in filtered result, got: $GEN_AT1_FILTERED"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT2: Generator Oscillation fixture → 필터 후 "Oscillation" 포함
# ---------------------------------------------------------------------------
GEN_AT2_RESULT=$(bash "$DETECT" "$GEN_FIXTURES/generator-oscillation.jsonl" 2>&1)
GEN_AT2_FILTERED=$(echo "$GEN_AT2_RESULT" | jq -c '.patterns | map(select(. == "Spinning" or . == "Oscillation"))' 2>/dev/null || echo '[]')
if echo "$GEN_AT2_FILTERED" | jq -e 'map(select(. == "Oscillation")) | length >= 1' > /dev/null 2>&1; then
  echo "PASS [GEN_AT2: Generator Oscillation fixture → filter yields Oscillation]"
  PASS=$((PASS + 1))
else
  echo "FAIL [GEN_AT2]: expected Oscillation in filtered result, got: $GEN_AT2_FILTERED"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT3: Generator no-stagnation fixture (3 distinct hashes) → 필터 후 빈 배열
# ---------------------------------------------------------------------------
GEN_AT3_RESULT=$(bash "$DETECT" "$GEN_FIXTURES/generator-no-stagnation.jsonl" 2>&1)
GEN_AT3_FILTERED=$(echo "$GEN_AT3_RESULT" | jq -c '.patterns | map(select(. == "Spinning" or . == "Oscillation"))' 2>/dev/null || echo '[]')
if [ "$GEN_AT3_FILTERED" = "[]" ]; then
  echo "PASS [GEN_AT3: Generator no-stagnation → filter yields empty array]"
  PASS=$((PASS + 1))
else
  echo "FAIL [GEN_AT3]: expected [] from no-stagnation fixture, got: $GEN_AT3_FILTERED"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT4: 5종 Generator 페르소나 파일 존재
# ---------------------------------------------------------------------------
GEN_AT4_FAIL=0
for p in tdd-purist library-seeker spec-reader refactorer skeptic; do
  pf="$GEN_PERSONAS_DIR/$p.md"
  if [ ! -f "$pf" ]; then
    fail "GEN_AT4: missing $pf"
    GEN_AT4_FAIL=1
  fi
done
if [ "$GEN_AT4_FAIL" -eq 0 ]; then
  echo "PASS [GEN_AT4: all 5 Generator persona files exist]"
  PASS=$((PASS + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT5: 각 페르소나 frontmatter (name, description) + 본문 ≤ 6000자
# ---------------------------------------------------------------------------
GEN_AT5_FAIL=0
for p in tdd-purist library-seeker spec-reader refactorer skeptic; do
  pf="$GEN_PERSONAS_DIR/$p.md"
  if [ ! -f "$pf" ]; then
    fail "GEN_AT5: missing $pf (skip content check)"
    GEN_AT5_FAIL=1
    continue
  fi
  # frontmatter checks
  if ! awk '/^---/{n++; next} n==1 && /^name:/{found=1} END{exit !found}' "$pf"; then
    fail "GEN_AT5: missing 'name:' in frontmatter of $pf"
    GEN_AT5_FAIL=1
  fi
  if ! awk '/^---/{n++; next} n==1 && /^description:/{found=1} END{exit !found}' "$pf"; then
    fail "GEN_AT5: missing 'description:' in frontmatter of $pf"
    GEN_AT5_FAIL=1
  fi
  # body ≤ 6000 chars
  body_chars=$(awk '/^---/{n++; next} n>=2' "$pf" | wc -c)
  if [ "$body_chars" -gt 6000 ]; then
    fail "GEN_AT5: body of $pf exceeds 6000 chars ($body_chars)"
    GEN_AT5_FAIL=1
  fi
done
if [ "$GEN_AT5_FAIL" -eq 0 ]; then
  echo "PASS [GEN_AT5: all Generator personas have valid frontmatter + body ≤6000 chars]"
  PASS=$((PASS + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT6: SKILL.md Phase 5a 직후 GENERATOR_HISTORY_FILE 변수 정의 + generator-history.jsonl 블록 존재
# ---------------------------------------------------------------------------
GEN_AT6_FAIL=0
if ! rg -q "GENERATOR_HISTORY_FILE=" "$SKILL_MD"; then
  fail "GEN_AT6a: missing GENERATOR_HISTORY_FILE= in SKILL.md"
  GEN_AT6_FAIL=1
fi
if ! rg -q "generator-history\.jsonl" "$SKILL_MD"; then
  fail "GEN_AT6b: missing generator-history.jsonl reference in SKILL.md"
  GEN_AT6_FAIL=1
fi
if [ "$GEN_AT6_FAIL" -eq 0 ]; then
  echo "PASS [GEN_AT6: GENERATOR_HISTORY_FILE + generator-history.jsonl in SKILL.md]"
  PASS=$((PASS + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT7: SKILL.md Generator retry 분기에 Spinning/Oscillation 필터 jq + personas/generator/ prepend 블록 존재
# ---------------------------------------------------------------------------
GEN_AT7_FAIL=0
if ! rg -q 'Spinning.*Oscillation|Oscillation.*Spinning' "$SKILL_MD"; then
  fail "GEN_AT7a: missing Spinning/Oscillation filter in SKILL.md"
  GEN_AT7_FAIL=1
fi
if ! rg -q "personas/generator/" "$SKILL_MD"; then
  fail "GEN_AT7b: missing personas/generator/ directory reference in SKILL.md"
  GEN_AT7_FAIL=1
fi
if [ "$GEN_AT7_FAIL" -eq 0 ]; then
  echo "PASS [GEN_AT7: Spinning/Oscillation filter jq + personas/generator/ prepend in SKILL.md]"
  PASS=$((PASS + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT8: ITERATOR_HISTORY_FILE / GENERATOR_HISTORY_FILE 는 별도 변수 (동일 라인 불가)
# ---------------------------------------------------------------------------
GEN_AT8_FAIL=0
if ! rg -q "ITERATOR_HISTORY_FILE" "$SKILL_MD"; then
  fail "GEN_AT8a: missing ITERATOR_HISTORY_FILE in SKILL.md"
  GEN_AT8_FAIL=1
fi
if ! rg -q "GENERATOR_HISTORY_FILE" "$SKILL_MD"; then
  fail "GEN_AT8b: missing GENERATOR_HISTORY_FILE in SKILL.md"
  GEN_AT8_FAIL=1
fi
# 두 변수가 동일 라인에 같이 나타나면 잘못된 통합 (identity assignment 등)
if rg -q "ITERATOR_HISTORY_FILE.*GENERATOR_HISTORY_FILE|GENERATOR_HISTORY_FILE.*ITERATOR_HISTORY_FILE" "$SKILL_MD"; then
  fail "GEN_AT8c: ITERATOR_HISTORY_FILE and GENERATOR_HISTORY_FILE must be on separate lines"
  GEN_AT8_FAIL=1
fi
if [ "$GEN_AT8_FAIL" -eq 0 ]; then
  echo "PASS [GEN_AT8: ITERATOR_HISTORY_FILE and GENERATOR_HISTORY_FILE are separate variables]"
  PASS=$((PASS + 1))
fi

# ---------------------------------------------------------------------------
# GEN_AT9: SKILL.md에 GEN_RETRY_COUNT > 4 가 정확히 1회 출현 (Iterator RETRY_COUNT > 4 와 별개)
# ---------------------------------------------------------------------------
GEN_RETRY_CAP_COUNT=$(rg -c "GEN_RETRY_COUNT > 4" "$SKILL_MD" 2>/dev/null || echo 0)
if [ "$GEN_RETRY_CAP_COUNT" -eq 1 ]; then
  echo "PASS [GEN_AT9: GEN_RETRY_COUNT > 4 appears exactly once in SKILL.md]"
  PASS=$((PASS + 1))
else
  fail "GEN_AT9: GEN_RETRY_COUNT > 4 must appear exactly once in SKILL.md (found: $GEN_RETRY_CAP_COUNT)"
fi

# ---------------------------------------------------------------------------
# GEN_AT10: SKILL.md Phase 5a-history 및 iterator-history append 블록이
#           untracked 파일을 포함하는 hash 계산 경로를 사용 (git ls-files --others)
# ---------------------------------------------------------------------------
if rg -q 'git ls-files --others' "$SKILL_MD"; then
  echo "PASS [GEN_AT10: SKILL.md uses git ls-files --others for untracked-aware hash]"
  PASS=$((PASS + 1))
else
  fail "GEN_AT10: SKILL.md missing 'git ls-files --others' — GEN_HASH/ITER_HASH not untracked-aware"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
