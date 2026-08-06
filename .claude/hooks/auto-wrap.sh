#!/bin/bash
# Stop hook: nudge a session wrap based on REAL context usage (v3).
#
# v2 estimated tokens from transcript byte size (250 KB ~= "15% of a 200k
# window") -- meaningless on 1M-window models and fired only once. v3 reads the
# last assistant message's usage from the transcript JSONL:
#   context = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
# which is the exact prompt size of the latest API call (includes system prompt,
# CLAUDE.md, skills, /start reads -- everything).
#
# Thresholds (percent of AUTOWRAP_WINDOW, default 1,000,000 tokens):
#   soft  AUTOWRAP_SOFT_PCT (default 15) -> finish current task, then /handoff wrap
#   hard  AUTOWRAP_HARD_PCT (default 17) -> stop new work, wrap NOW
# Rationale: on 1M models, requests past 20% (200k tokens) are billed at the 2x
# long-context premium rate -- wrapping by 17% keeps every request below it.
#
# Loop safety: stop_hook_active=true always allows the stop; each threshold
# fires at most ONCE per session (marker files in $TMP).

INPUT=$(cat)

STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""' | tr '\\' '/')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')

if [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Last main-thread assistant usage (subagent sidechains excluded).
CTX=$(jq -r 'select(.isSidechain != true) | .message.usage | select(.input_tokens != null) | (.input_tokens + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0))' "$TRANSCRIPT" 2>/dev/null | tail -1)
case "$CTX" in ''|*[!0-9]*) exit 0 ;; esac

WINDOW="${AUTOWRAP_WINDOW:-1000000}"
SOFT_PCT="${AUTOWRAP_SOFT_PCT:-15}"
HARD_PCT="${AUTOWRAP_HARD_PCT:-17}"
SOFT=$(( WINDOW * SOFT_PCT / 100 ))
HARD=$(( WINDOW * HARD_PCT / 100 ))

if [ "$CTX" -lt "$SOFT" ]; then
  exit 0
fi

PCT=$(( CTX * 100 / WINDOW ))
KTOK=$(( CTX / 1000 ))
TMP="${TMPDIR:-${TEMP:-/tmp}}"

if [ "$CTX" -ge "$HARD" ]; then
  MARKER="$TMP/claude-autowrap-hard-$SESSION_ID"
  if [ ! -f "$MARKER" ]; then
    touch "$MARKER"
    echo "AUTO-WRAP (HARD): context at ${PCT}% (${KTOK}k tokens) -- past the ${HARD_PCT}% hard limit. STOP new work and run the full /handoff wrap flow NOW: update handoff.md and commit locally without asking. Never push. If mid-task and state would be lost, run /handoff save first, then wrap." >&2
    exit 2
  fi
  exit 0
fi

MARKER="$TMP/claude-autowrap-soft-$SESSION_ID"
if [ ! -f "$MARKER" ]; then
  touch "$MARKER"
  echo "AUTO-WRAP: context at ${PCT}% (${KTOK}k tokens) -- crossed the ${SOFT_PCT}% wrap threshold. Finish the current task if it is mid-flight, then IMMEDIATELY run the full /handoff wrap flow: update handoff.md and commit locally, both WITHOUT asking for confirmation. Never push. After the wrap is complete you may stop." >&2
  exit 2
fi

exit 0
