#!/bin/bash
# PreToolUse: Block dangerous Bash/PowerShell command patterns
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

if [[ ! "$TOOL_NAME" =~ ^(Bash|PowerShell)$ ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# === Universal dangerous patterns ===
BLOCKED_PATTERNS=(
  'rm -rf /'
  'rm -rf ~'
  'rm -rf \.'
  'curl.*\|\s*(sudo\s+)?(ba|z|k)?sh(\s|$)'
  'wget.*\|\s*(sudo\s+)?(ba|z|k)?sh(\s|$)'
  ':\(\)\{.*\|.*&.*\};'
  'dd if=/dev'
  'mkfs\.'
  '> /dev/sd'
  'chmod -R 777 /'
  'eval.*\$\(curl'
)

# === PowerShell equivalents (this machine runs most commands via PowerShell) ===
BLOCKED_PATTERNS+=(
  'Remove-Item.*-Recurse.*-Force.*(C:\\($| )|\$env:USERPROFILE($| )|\$HOME($| )|~($| ))'
  'Remove-Item.*(C:\\($| )|\$env:USERPROFILE($| )).*-Recurse.*-Force'
  'Format-Volume'
  'Clear-Disk'
  'iex.*\(.*(iwr|Invoke-WebRequest|wget|curl)'
  'Invoke-Expression.*\(.*(iwr|Invoke-WebRequest)'
  'Set-ExecutionPolicy.*Unrestricted'
)

# === Project-specific patterns (add your own here) ===
BLOCKED_PATTERNS+=(
  'git push.*--force.*main'
  'git push.*--force.*master'
  'git push.*-f.*main'
  'git push.*-f.*master'
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED by safety hook: dangerous pattern [$pattern]" >&2
    exit 2
  fi
done

exit 0
