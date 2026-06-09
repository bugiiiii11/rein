#!/bin/bash
# PostToolUse: Scan tool output for prompt injection patterns
# Based on Lasso Security research (50+ attack signatures)
# Exit 0 always (PostToolUse can only warn, not prevent)
# NOTE: reads .tool_response (the actual PostToolUse field), not .tool_output

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

# Only scan tools that return external/untrusted content
case "$TOOL_NAME" in
  Read|WebFetch|WebSearch|Bash|PowerShell|Grep|Task) ;;
  *) exit 0 ;;
esac

OUTPUT=$(echo "$INPUT" | jq -r '(.tool_response // .tool_output // "") | tostring')

# Injection patterns -- HIGH severity
HIGH_PATTERNS=(
  'ignore all previous instructions'
  'ignore your instructions'
  'ignore prior instructions'
  'ignore above instructions'
  'disregard all previous'
  'disregard your instructions'
  'override your instructions'
  'new system prompt'
  'your new instructions are'
  'you are now DAN'
  'enter developer mode'
  'jailbreak mode'
  'ADMIN MESSAGE FROM ANTHROPIC'
  'SYSTEM OVERRIDE'
  'AI ADMIN'
)

# Injection patterns -- MEDIUM severity
MEDIUM_PATTERNS=(
  'do not reveal'
  'pretend you are'
  'act as if you'
  'you must not tell'
  'ignore the above'
  'forget everything'
  'reset your context'
  'from now on you will'
  'you have been reprogrammed'
)

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
AUDIT_FILE="$HOME/.claude/safety-audit.jsonl"

mkdir -p "$(dirname "$AUDIT_FILE")"

for pattern in "${HIGH_PATTERNS[@]}"; do
  if echo "$OUTPUT" | grep -qiE "$pattern"; then
    echo "[SAFETY WARNING] HIGH: Possible prompt injection in $TOOL_NAME output: '$pattern'" >&2
    echo "{\"ts\":\"$TIMESTAMP\",\"session\":\"$SESSION_ID\",\"tool\":\"$TOOL_NAME\",\"event\":\"injection_detected\",\"severity\":\"HIGH\",\"pattern\":$(echo "$pattern" | jq -Rs .)}" >> "$AUDIT_FILE"
  fi
done

for pattern in "${MEDIUM_PATTERNS[@]}"; do
  if echo "$OUTPUT" | grep -qiE "$pattern"; then
    echo "[SAFETY WARNING] MEDIUM: Suspicious pattern in $TOOL_NAME output: '$pattern'" >&2
    echo "{\"ts\":\"$TIMESTAMP\",\"session\":\"$SESSION_ID\",\"tool\":\"$TOOL_NAME\",\"event\":\"injection_suspected\",\"severity\":\"MEDIUM\",\"pattern\":$(echo "$pattern" | jq -Rs .)}" >> "$AUDIT_FILE"
  fi
done

exit 0
