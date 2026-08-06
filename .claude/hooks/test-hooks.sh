#!/bin/bash
# Smoke tests for auto-wrap.sh (Stop) and context-warn.sh (UserPromptSubmit).
# Run from the project root:  bash .claude/hooks/test-hooks.sh
# Uses synthetic transcript fixtures with real .message.usage shapes.
# Defaults under test: WINDOW=1,000,000 / soft 15% (150k) / hard 17% (170k).

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
AUTOWRAP="$HOOKS_DIR/auto-wrap.sh"
CTXWARN="$HOOKS_DIR/context-warn.sh"
FIX="$(mktemp -d)"
PASS=0
FAIL=0

usage_line() { # $1 = total tokens to encode (as cache_read; input=100, creation=0)
  echo "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-test\",\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":$(( $1 - 100 )),\"output_tokens\":50}}}"
}

# Fixtures: a user line (no usage), then an assistant usage line.
mk_fixture() { # $1 = file, $2 = total tokens
  {
    echo '{"type":"user","message":{"role":"user","content":"hi"}}'
    usage_line "$2"
  } > "$1"
}

mk_fixture "$FIX/low.jsonl"  100000   # 10% -> silent
mk_fixture "$FIX/soft.jsonl" 160000   # 16% -> soft fire
mk_fixture "$FIX/hard.jsonl" 180000   # 18% -> hard fire

# Sidechain fixture: main thread at 10%, then a HUGE sidechain usage line that
# must be ignored (subagent context is not the main window).
{
  usage_line 100000
  echo '{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":900000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}}'
} > "$FIX/sidechain.jsonl"

stdin_json() { # $1 = transcript path, $2 = session id, $3 = stop_hook_active
  echo "{\"transcript_path\":\"$1\",\"session_id\":\"$2\",\"stop_hook_active\":${3:-false}}"
}

check() { # $1 = name, $2 = expected exit, $3 = actual exit, $4 = expected substr, $5 = actual output
  local ok=1
  [ "$2" != "$3" ] && ok=0
  if [ -n "$4" ]; then
    case "$5" in *"$4"*) : ;; *) ok=0 ;; esac
  fi
  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); echo "PASS  $1"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $1 (exit $3, want $2; output: $5)"
  fi
}

RUN=$RANDOM$RANDOM  # unique session ids per run so markers never collide

# --- auto-wrap.sh ---
OUT=$(stdin_json "$FIX/low.jsonl" "t1-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: below soft -> allow stop" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/soft.jsonl" "t2-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: soft crossing -> block once" 2 $? "AUTO-WRAP: context at 16%" "$OUT"
OUT=$(stdin_json "$FIX/soft.jsonl" "t2-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: soft marker -> second stop allowed" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "t3-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: hard crossing -> block with HARD msg" 2 $? "AUTO-WRAP (HARD): context at 18%" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "t3-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: hard marker -> second stop allowed" 0 $? "" "$OUT"
# escalation: same session crosses soft, later hard -> two distinct fires
OUT=$(stdin_json "$FIX/soft.jsonl" "t4-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: escalation step 1 (soft)" 2 $? "AUTO-WRAP:" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "t4-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: escalation step 2 (hard)" 2 $? "HARD" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "t4-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: escalation exhausted -> allow" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "t5-$RUN" true | bash "$AUTOWRAP" 2>&1); check "autowrap: stop_hook_active loop guard" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/missing.jsonl" "t6-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: missing transcript -> silent" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/sidechain.jsonl" "t7-$RUN" | bash "$AUTOWRAP" 2>&1); check "autowrap: sidechain usage ignored" 0 $? "" "$OUT"
OUT=$(stdin_json "$FIX/soft.jsonl" "t8-$RUN" | AUTOWRAP_WINDOW=2000000 bash "$AUTOWRAP" 2>&1); check "autowrap: env window override (160k of 2M = 8%)" 0 $? "" "$OUT"

# --- context-warn.sh ---
OUT=$(stdin_json "$FIX/low.jsonl" "w1-$RUN" | bash "$CTXWARN" 2>&1); check "ctxwarn: below soft -> silent" 0 $? "" "$OUT"
[ -z "$OUT" ] && { PASS=$((PASS+1)); echo "PASS  ctxwarn: below soft -> empty stdout"; } || { FAIL=$((FAIL+1)); echo "FAIL  ctxwarn: expected empty stdout, got: $OUT"; }
OUT=$(stdin_json "$FIX/soft.jsonl" "w2-$RUN" | bash "$CTXWARN" 2>&1); check "ctxwarn: soft -> advisory line" 0 $? "Context at 16%" "$OUT"
OUT=$(stdin_json "$FIX/hard.jsonl" "w3-$RUN" | bash "$CTXWARN" 2>&1); check "ctxwarn: hard -> hard-limit line" 0 $? "hard limit" "$OUT"
OUT=$(stdin_json "$FIX/sidechain.jsonl" "w4-$RUN" | bash "$CTXWARN" 2>&1)
[ -z "$OUT" ] && { PASS=$((PASS+1)); echo "PASS  ctxwarn: sidechain usage ignored"; } || { FAIL=$((FAIL+1)); echo "FAIL  ctxwarn: sidechain not ignored: $OUT"; }

rm -rf "$FIX"
echo "----"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
