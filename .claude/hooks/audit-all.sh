#!/bin/bash
# PostToolUse: Log Bash/PowerShell commands and WebFetch URLs to JSONL audit file
# Audit file: ~/.claude/safety-audit.jsonl

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id')
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
AUDIT_FILE="$HOME/.claude/safety-audit.jsonl"

# Ensure audit dir exists
mkdir -p "$(dirname "$AUDIT_FILE")"

case "$TOOL_NAME" in
  Bash|PowerShell)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // "unknown"')
    echo "{\"ts\":\"$TIMESTAMP\",\"session\":\"$SESSION_ID\",\"tool\":\"$TOOL_NAME\",\"command\":$(echo "$COMMAND" | jq -Rs .)}" >> "$AUDIT_FILE"
    ;;
  WebFetch)
    URL=$(echo "$INPUT" | jq -r '.tool_input.url // "unknown"')
    echo "{\"ts\":\"$TIMESTAMP\",\"session\":\"$SESSION_ID\",\"tool\":\"WebFetch\",\"url\":$(echo "$URL" | jq -Rs .)}" >> "$AUDIT_FILE"
    ;;
  WebSearch)
    QUERY=$(echo "$INPUT" | jq -r '.tool_input.query // "unknown"')
    echo "{\"ts\":\"$TIMESTAMP\",\"session\":\"$SESSION_ID\",\"tool\":\"WebSearch\",\"query\":$(echo "$QUERY" | jq -Rs .)}" >> "$AUDIT_FILE"
    ;;
esac

exit 0
