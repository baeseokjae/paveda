#!/usr/bin/env bash
# detect-stagnation-cross-sprint.sh — Cross-sprint meta-stagnation detection (D3)
# Usage: detect-stagnation-cross-sprint.sh <path-to-iterator-history.jsonl>
# Output: JSON {"meta_stagnation": bool, "pattern": str|null, "sprints": [int...]}
# Exit: 0 (normal), 1 (missing file argument or file not found)
#
# 로직:
#   1. iterator-history.jsonl에서 distinct sprint 번호를 추출
#   2. 각 sprint N에 대해 detect-stagnation.sh --current-sprint N 호출하여 .patterns 배열 수집
#   3. 패턴별 등장 sprint 목록 집계 (tally) — jq를 사용하여 집계
#   4. 3 개 이상의 distinct sprint에서 동일 패턴이 등장하면 meta_stagnation=true
#   5. 패턴 선택: 등장 횟수 최다, 동수 시 알파벳순 첫 번째

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT="$SCRIPT_DIR/detect-stagnation.sh"

# --- 인자 검증 ---
if [ $# -lt 1 ]; then
  echo '{"meta_stagnation":false,"pattern":null,"sprints":[]}' >&2
  exit 1
fi

INPUT="$1"

if [ ! -f "$INPUT" ]; then
  echo "detect-stagnation-cross-sprint.sh: file not found: $INPUT" >&2
  exit 1
fi

# --- 빈 파일 처리 ---
if [ ! -s "$INPUT" ]; then
  echo '{"meta_stagnation":false,"pattern":null,"sprints":[]}'
  exit 0
fi

# --- Distinct sprint 번호 추출 (정수 coercion, null/0 제외, 오름차순 정렬) ---
JQ_ERR_FILE=$(mktemp)
trap "rm -f '$JQ_ERR_FILE'" EXIT
SPRINTS=$(jq -s '[.[].sprint // empty | tonumber? // empty] | map(select(. > 0)) | unique | sort | .[]' \
  "$INPUT" 2>"$JQ_ERR_FILE") || {
  echo '{"meta_stagnation":false,"pattern":null,"sprints":[],"error":"malformed_history"}' >&2
  echo '{"meta_stagnation":false,"pattern":null,"sprints":[],"error":"malformed_history"}'
  exit 2
}

if [ -z "$SPRINTS" ]; then
  echo '{"meta_stagnation":false,"pattern":null,"sprints":[]}'
  exit 0
fi

# --- 각 sprint별 패턴 수집 → tally JSON 빌드 ---
# tally 형식: [{"pattern":"Spinning","sprint":1}, {"pattern":"Spinning","sprint":2}, ...]
TALLY_ENTRIES="[]"

while IFS= read -r sprint_num; do
  # detect-stagnation.sh 호출 → 실패 시 malformed_history로 fail-closed
  if ! SPRINT_RAW=$(bash "$DETECT" "$INPUT" --current-sprint "$sprint_num"); then
    echo "{\"meta_stagnation\":false,\"pattern\":null,\"sprints\":[],\"error\":\"malformed_history\",\"sprint_failed\":$sprint_num}" >&2
    echo "{\"meta_stagnation\":false,\"pattern\":null,\"sprints\":[],\"error\":\"malformed_history\",\"sprint_failed\":$sprint_num}"
    exit 2
  fi
  SPRINT_PATTERNS=$(echo "$SPRINT_RAW" | jq -c '.patterns')
  JQ_EXIT=$?
  if [ $JQ_EXIT -ne 0 ]; then
    echo "{\"meta_stagnation\":false,\"pattern\":null,\"sprints\":[],\"error\":\"malformed_history\",\"sprint_failed\":$sprint_num}" >&2
    echo "{\"meta_stagnation\":false,\"pattern\":null,\"sprints\":[],\"error\":\"malformed_history\",\"sprint_failed\":$sprint_num}"
    exit 2
  fi

  # 각 패턴에 대해 {pattern, sprint} 엔트리 생성 후 tally에 병합
  NEW_ENTRIES=$(jq -cn \
    --argjson patterns "$SPRINT_PATTERNS" \
    --argjson sprint "$sprint_num" \
    '$patterns | map({"pattern": ., "sprint": $sprint})')

  TALLY_ENTRIES=$(jq -cn \
    --argjson existing "$TALLY_ENTRIES" \
    --argjson new "$NEW_ENTRIES" \
    '$existing + $new')
done <<< "$SPRINTS"

# --- 패턴별 distinct sprint 수 집계 → 임계값 3 이상 탐색 ---
# 알파벳순 정렬 후 최초 매칭 패턴 선택 (deterministic)
RESULT=$(jq -cn \
  --argjson tally "$TALLY_ENTRIES" \
  --argjson threshold 3 '
  # 패턴별 distinct sprint 목록 집계
  (
    $tally
    | group_by(.pattern)
    | map({
        pattern: .[0].pattern,
        sprints: ([.[].sprint] | unique | sort)
      })
    | map(select((.sprints | length) >= ($threshold | tonumber)))
    | sort_by(-(.sprints | length), .pattern)
  ) as $candidates |

  if ($candidates | length) == 0
  then {"meta_stagnation": false, "pattern": null, "sprints": []}
  else
    ($candidates[0]) as $winner |
    {"meta_stagnation": true, "pattern": $winner.pattern, "sprints": $winner.sprints}
  end
')

echo "$RESULT"
