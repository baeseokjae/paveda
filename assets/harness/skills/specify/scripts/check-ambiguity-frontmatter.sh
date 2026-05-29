#!/usr/bin/env bash
# check-ambiguity-frontmatter.sh
# Validates that /specify/SKILL.md and /do/SKILL.md contain the required
# ambiguity-score-gate patch content.
# Exit 0 = all PASS, Exit 1 = one or more FAIL

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SPECIFY_SKILL="${SKILL_ROOT}/specify/SKILL.md"
DO_SKILL="${SKILL_ROOT}/do/SKILL.md"

PASS=0
FAIL=1
all_pass=true

check() {
  local id="$1"
  local description="$2"
  local result="$3"  # "pass" or "fail"
  if [ "$result" = "pass" ]; then
    echo "PASS [$id] $description"
  else
    echo "FAIL [$id] $description"
    all_pass=false
  fi
}

# ── Helper: extract text of a section (from header to next --- or next ### at same level)
# Returns the text between two patterns (inclusive start, exclusive end)
extract_section() {
  local file="$1"
  local start_pattern="$2"
  local end_pattern="$3"
  awk "/${start_pattern}/{found=1} found{print} /${end_pattern}/{if(found && NR>1){exit}}" "$file" 2>/dev/null || true
}

# ── Helper: extract frontmatter (between first two --- lines)
extract_frontmatter() {
  local file="$1"
  awk '/^---/{count++; if(count==2){exit} next} count==1{print}' "$file" 2>/dev/null || true
}

# ── (A) /specify/SKILL.md checks ──────────────────────────────────────────────

# Section: Phase 3c (between "#### 3c: 인터뷰 루프" and next "---\n" section separator)
PHASE3C=$(awk '/#### 3c: 인터뷰 루프/{found=1} found{print} /^---$/{if(found && NR>5){exit}}' "$SPECIFY_SKILL" 2>/dev/null || true)

# Section: Phase 5 (between "### Phase 5: 출력" and "## Design Principles" or EOF)
PHASE5=$(awk '/### Phase 5: 출력/{found=1} found{print} /## Design Principles/{if(found){exit}}' "$SPECIFY_SKILL" 2>/dev/null || true)

# A1: IS_BROWNFIELD keyword in Phase 3c section (weight branch)
if echo "$PHASE3C" | grep -q "IS_BROWNFIELD"; then
  check "A1" "IS_BROWNFIELD 가중치 분기가 Phase 3c에 등장" "pass"
else
  check "A1" "IS_BROWNFIELD 가중치 분기가 Phase 3c에 등장" "fail"
fi

# A2: 0.35 AND 0.25 AND 0.15 weights in Phase 3c (Brownfield 4-dimension)
if echo "$PHASE3C" | grep -q "0\.35" && \
   echo "$PHASE3C" | grep -q "0\.25" && \
   echo "$PHASE3C" | grep -q "0\.15"; then
  check "A2" "Brownfield 4차원 가중치 0.35/0.25/0.15 등장" "pass"
else
  check "A2" "Brownfield 4차원 가중치 0.35/0.25/0.15 등장" "fail"
fi

# A3: context_clarity dimension in Phase 3c
if echo "$PHASE3C" | grep -q "context_clarity"; then
  check "A3" "context_clarity 차원 등장 (Brownfield 한정)" "pass"
else
  check "A3" "context_clarity 차원 등장 (Brownfield 한정)" "fail"
fi

# A4: ambiguity_score AND clarity_dimensions AND is_brownfield in Phase 5
if echo "$PHASE5" | grep -q "ambiguity_score" && \
   echo "$PHASE5" | grep -q "clarity_dimensions" && \
   echo "$PHASE5" | grep -q "is_brownfield"; then
  check "A4" "ambiguity_score/clarity_dimensions/is_brownfield가 Phase 5(출력)에 등장" "pass"
else
  check "A4" "ambiguity_score/clarity_dimensions/is_brownfield가 Phase 5(출력)에 등장" "fail"
fi

# A5: temperature 0.1 guideline in Phase 3c self-eval
if echo "$PHASE3C" | grep -qE "temperature 0\.1|temp 0\.1"; then
  check "A5" "temperature 0.1 결정성 가이드라인이 Phase 3c에 등장" "pass"
else
  check "A5" "temperature 0.1 결정성 가이드라인이 Phase 3c에 등장" "fail"
fi

# A6: lowest clarity dimension forcing mechanism in Phase 3c
if echo "$PHASE3C" | grep -qE "lowest|가장 낮은 clarity|부족 차원 강제|lowest_dimension"; then
  check "A6" "부족 차원 강제 재질문 메커니즘이 Phase 3c에 등장" "pass"
else
  check "A6" "부족 차원 강제 재질문 메커니즘이 Phase 3c에 등장" "fail"
fi

# ── (B) /do/SKILL.md checks ───────────────────────────────────────────────────

# Section around Phase 1.5 end / Phase 1.6 insertion area
# Extract from Phase 1.5 header to Phase 2 header
PHASE15_TO_2=$(awk '/### Phase 1\.5: Interview Gate/{found=1} found{print} /### Phase 2:/{if(found && NR>5){exit}}' "$DO_SKILL" 2>/dev/null || true)

# B1: ambiguity_score keyword in Phase 1.5+ gate area (Phase 1.6)
if echo "$PHASE15_TO_2" | grep -q "ambiguity_score"; then
  check "B1" "ambiguity_score가 Phase 1.5 직후 게이트 영역에 등장" "pass"
else
  check "B1" "ambiguity_score가 Phase 1.5 직후 게이트 영역에 등장" "fail"
fi

# B2: fallback / 필드 누락 text
if echo "$PHASE15_TO_2" | grep -qE "0\.0 fallback|필드 누락"; then
  check "B2" "0.0 fallback 또는 필드 누락 하위 호환 처리 텍스트 등장" "pass"
else
  check "B2" "0.0 fallback 또는 필드 누락 하위 호환 처리 텍스트 등장" "fail"
fi

# B3: 0.2 threshold
if echo "$PHASE15_TO_2" | grep -qE "0\.2|≤ 0\.2|> 0\.2"; then
  check "B3" "0.2 게이트 임계값 등장" "pass"
else
  check "B3" "0.2 게이트 임계값 등장" "fail"
fi

# B4: AskUserQuestion in gate handling (soft-warn)
if echo "$PHASE15_TO_2" | grep -q "AskUserQuestion"; then
  check "B4" "AskUserQuestion이 게이트 처리에 등장 (soft-warn)" "pass"
else
  check "B4" "AskUserQuestion이 게이트 처리에 등장 (soft-warn)" "fail"
fi

# ── (C) frontmatter validity ──────────────────────────────────────────────────

validate_frontmatter() {
  local file="$1"
  local label="$2"
  local fm
  fm=$(extract_frontmatter "$file")
  if [ -z "$fm" ]; then
    echo "FAIL [C-$label] frontmatter 추출 실패 (빈 결과)"
    all_pass=false
    return
  fi
  # Try python3 + pyyaml first, then ruby yaml, then grep-based heuristic
  local valid=false
  if python3 -c "import yaml, sys; yaml.safe_load(sys.stdin.read())" <<< "$fm" 2>/dev/null; then
    valid=true
  elif ruby -e "require 'yaml'; YAML.safe_load(STDIN.read)" <<< "$fm" 2>/dev/null; then
    valid=true
  else
    # Heuristic: check that frontmatter has at least name and description keys
    if echo "$fm" | grep -q "^name:" && echo "$fm" | grep -q "^description:"; then
      valid=true
    fi
  fi
  if $valid; then
    echo "PASS [C-$label] frontmatter YAML valid ($label)"
  else
    echo "FAIL [C-$label] frontmatter YAML invalid ($label)"
    all_pass=false
  fi
}

validate_frontmatter "$SPECIFY_SKILL" "specify"
validate_frontmatter "$DO_SKILL" "do"

# C2: name field preserved
SPECIFY_NAME=$(extract_frontmatter "$SPECIFY_SKILL" | grep "^name:" | head -1 | awk '{print $2}' | tr -d '"')
DO_NAME=$(extract_frontmatter "$DO_SKILL" | grep "^name:" | head -1 | awk '{print $2}' | tr -d '"')

if [ "$SPECIFY_NAME" = "specify" ]; then
  check "C2a" "specify SKILL.md의 name 필드 = specify 보존" "pass"
else
  check "C2a" "specify SKILL.md의 name 필드 = specify 보존 (got: '${SPECIFY_NAME}')" "fail"
fi

if [ "$DO_NAME" = "do" ]; then
  check "C2b" "do SKILL.md의 name 필드 = do 보존" "pass"
else
  check "C2b" "do SKILL.md의 name 필드 = do 보존 (got: '${DO_NAME}')" "fail"
fi

# C3: Phase ordering in do/SKILL.md (Phase 1.5 → 1.6 → Phase 2 in order)
PH15_LINE=$(grep -n "### Phase 1\.5:" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
PH16_LINE=$(grep -n "### Phase 1\.6:" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
PH2_LINE=$(grep -n "### Phase 2:" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
PH15_LINE="${PH15_LINE:-0}"
PH16_LINE="${PH16_LINE:-0}"
PH2_LINE="${PH2_LINE:-0}"

if [ "$PH15_LINE" -gt 0 ] && [ "$PH16_LINE" -gt 0 ] && [ "$PH2_LINE" -gt 0 ] && \
   [ "$PH15_LINE" -lt "$PH16_LINE" ] && [ "$PH16_LINE" -lt "$PH2_LINE" ]; then
  check "C3" "do SKILL.md Phase 순서: 1.5 → 1.6 → 2 (순서 보존)" "pass"
else
  check "C3" "do SKILL.md Phase 1.5(L${PH15_LINE}), 1.6(L${PH16_LINE}), 2(L${PH2_LINE}) 순서 확인" "fail"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
if $all_pass; then
  echo "✓ All checks PASS"
  exit 0
else
  echo "✗ One or more checks FAILED"
  exit 1
fi
