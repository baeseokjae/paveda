#!/usr/bin/env bash
# detect-stagnation.sh — detect iteration stagnation patterns from iterator-history.jsonl
# Usage: detect-stagnation.sh <path-to-iterator-history.jsonl> [--current-sprint <n>]
# Output: JSON {"patterns":[...], "personas":[...]}
# Exit: 0 (normal), 1 (missing file or parse failure)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo '{"patterns":[], "personas":[]}' >&2
  exit 1
fi

INPUT="$1"
CURRENT_SPRINT_ARG=""

# Parse optional --current-sprint <n> argument
shift
while [ $# -gt 0 ]; do
  case "$1" in
    --current-sprint)
      shift
      CURRENT_SPRINT_ARG="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ ! -f "$INPUT" ]; then
  echo "detect-stagnation.sh: file not found: $INPUT" >&2
  exit 1
fi

# Run all 4 pattern checks + persona union in a single jq program
# --slurpfile reads INPUT as a JSON array into $history (avoids ARG_MAX with large files)
jq -n --slurpfile history "$INPUT" --argjson current_sprint "${CURRENT_SPRINT_ARG:-0}" '
def abs(x): if x < 0 then -x else x end;

# Filter to specified sprint or latest sprint (sprint coerced to number; fallback to all if .sprint absent)
(
  if $current_sprint > 0
  then $history | map(select((.sprint // 0 | tonumber? // 0) == $current_sprint))
  else
    ($history | map(.sprint // 0 | tonumber? // 0) | max) as $latest_sprint |
    if $latest_sprint > 0
    then $history | map(select((.sprint // 0 | tonumber? // 0) == $latest_sprint))
    else $history
    end
  end
) as $h |
($h | length) as $n |

# --- Spinning: same output_hash_normalized (non-null, non-empty) appears >= 3 times ---
(
  if $n < 3 then false
  else
    (
      $h | map(select(.output_hash_normalized != null and .output_hash_normalized != ""))
         | group_by(.output_hash_normalized)
         | map(length)
         | if length == 0 then 0 else max end
    ) >= 3
  end
) as $spinning |

# --- Oscillation: last 4 hashes form A→B→A→B pattern (A != B) ---
(
  if $n < 4 then false
  else
    ($h[-4].output_hash_normalized) as $a |
    ($h[-3].output_hash_normalized) as $b |
    ($h[-2].output_hash_normalized) as $c |
    ($h[-1].output_hash_normalized) as $d |
    ($a == $c) and ($b == $d) and ($a != $b)
  end
) as $oscillation |

# --- No-Drift: last 3 numeric match_rate consecutive deltas all < 0.01 ---
# Entries with null/non-numeric match_rate are excluded; check only fires when >= 3 numeric values
(
  ($h | map(.match_rate | numbers)) as $rates |
  if ($rates | length) < 3 then false
  else
    ($rates[-1:][0]) as $r1 |
    ($rates[-2:-1][0]) as $r2 |
    ($rates[-3:-2][0]) as $r3 |
    (abs($r1 - $r2) < 0.01) and (abs($r2 - $r3) < 0.01)
  end
) as $no_drift |

# --- Diminishing Returns: last 3 numeric match_rate total span < 0.01 ---
(
  ($h | map(.match_rate | numbers)) as $rates |
  if ($rates | length) < 3 then false
  else
    ($rates[-1:][0]) as $r1 |
    ($rates[-3:-2][0]) as $r3 |
    abs($r1 - $r3) < 0.01
  end
) as $diminishing |

# Build patterns list (detection order: Spinning, Oscillation, No-Drift, Diminishing)
(
  [] |
  (if $spinning then . + ["Spinning"] else . end) |
  (if $oscillation then . + ["Oscillation"] else . end) |
  (if $no_drift then . + ["No-Drift"] else . end) |
  (if $diminishing then . + ["Diminishing"] else . end)
) as $patterns |

# Build personas: union of affiliated personas + Contrarian if any pattern matched
(
  [] |
  (if $spinning then . + ["Hacker"] else . end) |
  (if $oscillation then . + ["Architect", "Simplifier"] else . end) |
  (if $no_drift then . + ["Researcher", "Architect"] else . end) |
  (if $diminishing then . + ["Researcher", "Simplifier"] else . end) |
  unique |
  (if ($patterns | length) > 0 then . + ["Contrarian"] | unique else . end) |
  sort
) as $personas |

{"patterns": $patterns, "personas": $personas}
'
