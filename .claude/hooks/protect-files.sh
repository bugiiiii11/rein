#!/bin/bash
# PreToolUse: Block Write/Edit on sensitive files
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

if [[ ! "$TOOL_NAME" =~ ^(Edit|Write)$ ]]; then
  exit 0
fi

# Normalize Windows backslashes so patterns like .aws/credentials match
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' | tr '\\' '/')

# Sensitive file patterns -- block Write/Edit
BLOCKED=(
  '\.env$'
  '\.env\.'
  '\.pem$'
  '\.key$'
  '\.p12$'
  '\.pfx$'
  '\.keystore$'
  'id_rsa'
  'id_ed25519'
  'id_ecdsa'
  '\.ssh/config'
  'credentials\.json'
  'service.account\.json'
  'secret'
  '\.aws/credentials'
  '\.aws/config'
  'kubeconfig'
  '\.kube/config'
  '\.npmrc$'
  '\.pypirc$'
  'token\.json$'
  '\.netrc$'
  '\.docker/config\.json'
  '\.git-credentials'
)

for pattern in "${BLOCKED[@]}"; do
  if echo "$FILE" | grep -qiE "$pattern"; then
    echo "BLOCKED by safety hook: sensitive file [$FILE]" >&2
    exit 2
  fi
done

exit 0
