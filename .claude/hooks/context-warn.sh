#!/bin/bash
# UserPromptSubmit hook: advisory context-usage warning (v3 companion to
# auto-wrap.sh). Same real-usage math; stdout (exit 0) is injected as context,
# so the warning lands BEFORE new work begins -- catching the case where one
# long turn crossed the threshold and the Stop-hook nudge is still pending.
# Never blocks. Repeats each prompt while over threshold (one line).

INPUT=$(cat)

TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // ""' | tr '\\' '/')

if [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

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

if [ "$CTX" -ge "$HARD" ]; then
  echo "[context-warn] Context at ${PCT}% (${KTOK}k tokens) -- past the ${HARD_PCT}% hard limit. Run /handoff wrap (or /handoff save) before taking on any new work."
else
  echo "[context-warn] Context at ${PCT}% (${KTOK}k tokens) -- over the ${SOFT_PCT}% wrap threshold. Prefer wrapping (/handoff wrap) before starting new work."
fi

exit 0
