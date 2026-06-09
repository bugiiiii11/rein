#!/bin/bash
# PreToolUse: Block WebFetch to internal/suspicious URLs (SSRF protection)
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

if [ "$TOOL_NAME" != "WebFetch" ]; then
  exit 0
fi

URL=$(echo "$INPUT" | jq -r '.tool_input.url // ""')

BLOCKED_PATTERNS=(
  'localhost'
  '127\.0\.0\.1'
  '0\.0\.0\.0'
  '192\.168\.'
  '10\.[0-9]+\.[0-9]+\.[0-9]+'
  '172\.(1[6-9]|2[0-9]|3[01])\.'
  '\[::1\]'
  'bit\.ly/'
  'tinyurl\.com/'
  'file://'
  'ftp://'
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$URL" | grep -qE "$pattern"; then
    echo "BLOCKED by safety hook: internal/suspicious URL [$URL]" >&2
    exit 2
  fi
done

exit 0
