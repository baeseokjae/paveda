#!/usr/bin/env bash
# check-ambiguity-frontmatter.sh
# Validates that /specify/SKILL.md keeps ambiguity scoring and /do/SKILL.md
# keeps the Paveda contract-shell obligations.
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

DO_TEXT=$(cat "$DO_SKILL" 2>/dev/null || true)

# B1: contract shell title
if echo "$DO_TEXT" | grep -q "# /do - Paveda Contract Shell"; then
  check "B1" "do SKILL.md가 Paveda contract shell 제목을 포함" "pass"
else
  check "B1" "do SKILL.md가 Paveda contract shell 제목을 포함" "fail"
fi

# B2: host-native primitive preservation
if echo "$DO_TEXT" | grep -q "Host-Native Execution"; then
  check "B2" "host-native 실행 원칙이 등장" "pass"
else
  check "B2" "host-native 실행 원칙이 등장" "fail"
fi

# B3: projection drift preflight
if echo "$DO_TEXT" | grep -q "paveda projection status --host <host>"; then
  check "B3" "projection drift preflight 명령이 등장" "pass"
else
  check "B3" "projection drift preflight 명령이 등장" "fail"
fi

# B4: unit/e2e and not_applicable policy
if echo "$DO_TEXT" | grep -q "Unit evidence is mandatory" && \
   echo "$DO_TEXT" | grep -q "metadata.classifierReason"; then
  check "B4" "unit/e2e gate와 audited not_applicable 정책이 등장" "pass"
else
  check "B4" "unit/e2e gate와 audited not_applicable 정책이 등장" "fail"
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

# C3: section ordering in do/SKILL.md
START_LINE=$(grep -n "## Required Start" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
RUN_LINE=$(grep -n "## Run Creation" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
HOST_LINE=$(grep -n "## Host-Native Execution" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
GATE_LINE=$(grep -n "## Test Gate Rules" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
VERIFY_LINE=$(grep -n "## Verification" "$DO_SKILL" | head -1 | cut -d: -f1 || true)
START_LINE="${START_LINE:-0}"
RUN_LINE="${RUN_LINE:-0}"
HOST_LINE="${HOST_LINE:-0}"
GATE_LINE="${GATE_LINE:-0}"
VERIFY_LINE="${VERIFY_LINE:-0}"

if [ "$START_LINE" -gt 0 ] && [ "$RUN_LINE" -gt 0 ] && [ "$HOST_LINE" -gt 0 ] && \
   [ "$GATE_LINE" -gt 0 ] && [ "$VERIFY_LINE" -gt 0 ] && \
   [ "$START_LINE" -lt "$RUN_LINE" ] && [ "$RUN_LINE" -lt "$HOST_LINE" ] && \
   [ "$HOST_LINE" -lt "$GATE_LINE" ] && [ "$GATE_LINE" -lt "$VERIFY_LINE" ]; then
  check "C3" "do SKILL.md section 순서: start → run → host-native → gates → verify" "pass"
else
  check "C3" "do SKILL.md section 순서 확인 start(L${START_LINE}) run(L${RUN_LINE}) host(L${HOST_LINE}) gate(L${GATE_LINE}) verify(L${VERIFY_LINE})" "fail"
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
