#!/bin/bash
# PreToolUse: Block dangerous Bash/PowerShell command patterns
# Exit 2 = block, Exit 0 = allow

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

if [[ ! "$TOOL_NAME" =~ ^(Bash|PowerShell)$ ]]; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

block() {
  echo "BLOCKED by safety hook: $1" >&2
  exit 2
}

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

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    block "dangerous pattern [$pattern]"
  fi
done

# === Project-specific: force-push to a protected branch ===
#
# Matched as an INVOCATION, never as a substring. The patterns this replaced
# ('git push.*--force.*main') tested the raw command TEXT, so merely WRITING that
# string into a file -- an echo, or a heredoc in a doc -- was blocked as if it
# were a push. Three conditions must now hold in the SAME command segment:
#
#   1. the segment IS a `git push` invocation (`git -C dir push` counts; a push
#      quoted inside some other command's argument does not),
#   2. a force flag appears as a WHOLE TOKEN (so `--follow-tags` no longer reads
#      as `-f`), and
#   3. a protected branch is named as a whole word -- or no refspec is given at
#      all and the CURRENT branch is protected, which is the bare `git push -f`
#      that the old patterns missed entirely.
#
# Heredoc bodies are stripped before matching: a heredoc body is data being
# written, not a command being run.
#
# Known gap, accepted deliberately: a push hidden in a string that some other
# program executes (one level of `bash -c "..."` is unwrapped below; anything
# deeper is not). This guard exists to stop an ACCIDENTAL force-push, not a
# determined bypass -- once a command writes a script and then runs it, no
# text-matching hook can see inside.

PROTECTED_BRANCHES='main|master'

# A heredoc body is data. Drop it, so documenting a command is not running it.
# If a heredoc is never terminated we cannot tell data from command -- scan the
# whole thing rather than risk stripping a real one.
strip_heredoc_bodies() {
  local line delim="" in_hd=0 out="" raw="" scan t
  local hd_re='<<-?[[:space:]]*([^[:space:]<>|&;()]+)'
  while IFS= read -r line || [[ -n "$line" ]]; do
    raw+="$line"$'\n'
    if (( in_hd )); then
      t="${line#"${line%%[![:space:]]*}"}"
      t="${t%"${t##*[![:space:]]}"}"
      [[ "$t" == "$delim" ]] && in_hd=0
      continue
    fi
    out+="$line"$'\n'
    scan="${line//<<</   }"   # a herestring is not a heredoc
    if [[ "$scan" =~ $hd_re ]]; then
      delim="${BASH_REMATCH[1]//\"/}"
      delim="${delim//\'/}"
      delim="${delim//\\/}"
      in_hd=1
    fi
  done
  if (( in_hd )); then printf '%s' "$raw"; else printf '%s' "$out"; fi
}

# One logical command per line: join line continuations, then cut on separators.
split_segments() {
  printf '%s\n' "$1" \
    | sed -e ':a' -e '/\\$/N; s/\\\n/ /; ta' \
    | sed -e 's/&&/\n/g' -e 's/||/\n/g' -e 's/[;&|(){}`]/\n/g'
}

current_branch() {
  git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null
}

is_force_push_to_protected() {
  local seg="$1" tok rest args=0 explicit=""
  seg="${seg#"${seg%%[![:space:]]*}"}"

  # FOO=bar git push ...
  while [[ "$seg" =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+ ]]; do
    seg="${seg#"${BASH_REMATCH[0]}"}"
  done

  [[ "$seg" == git || "$seg" == git[[:space:]]* ]] || return 1
  rest="${seg#git}"
  rest="${rest#"${rest%%[![:space:]]*}"}"

  # git's own global options, so `git -C dir push` and `git -c k=v push` count
  while [[ "$rest" == -* ]]; do
    tok="${rest%%[[:space:]]*}"
    rest="${rest#"$tok"}"; rest="${rest#"${rest%%[![:space:]]*}"}"
    if [[ "$tok" == "-c" || "$tok" == "-C" ]]; then
      tok="${rest%%[[:space:]]*}"
      rest="${rest#"$tok"}"; rest="${rest#"${rest%%[![:space:]]*}"}"
    fi
  done

  [[ "$rest" == push || "$rest" == push[[:space:]]* ]] || return 1
  rest="${rest#push}"

  # A force flag, as a whole token
  [[ "$rest" =~ (^|[[:space:]])(--force|--force-with-lease|--force-if-includes)([[:space:]=]|$) ]] \
    || [[ "$rest" =~ (^|[[:space:]])-[A-Za-z]*f[A-Za-z]*([[:space:]]|$) ]] \
    || return 1

  # Explicit refspec? <remote> <ref> means 2+ non-flag args; fewer than that and
  # the push resolves to whatever branch is checked out right now.
  for tok in $rest; do
    [[ "$tok" == -* ]] && continue
    args=$(( args + 1 ))
    explicit="$explicit $tok"
  done

  if (( args >= 2 )); then
    [[ "$explicit" =~ (^|[[:space:]:+/])($PROTECTED_BRANCHES)([[:space:]]|$) ]] && return 0
    return 1
  fi

  # No refspec: fail closed if the current branch cannot be read.
  local br; br="$(current_branch)"
  [[ -z "$br" || "$br" =~ ^($PROTECTED_BRANCHES)$ ]] && return 0
  return 1
}

scan_for_force_push() {
  local text="$1" seg sub first
  while IFS= read -r seg || [[ -n "$seg" ]]; do
    [[ -z "${seg//[[:space:]]/}" ]] && continue
    if is_force_push_to_protected "$seg"; then
      block "force-push to a protected branch [$(echo "$seg" | tr -s '[:space:]' ' ')]"
    fi
    # one level of `bash -c "..."` / `pwsh -c "..."`
    first="${seg#"${seg%%[![:space:]]*}"}"; first="${first%%[[:space:]]*}"
    first="${first##*/}"
    if [[ "$first" =~ ^(bash|sh|zsh|ksh|pwsh|powershell|cmd)(\.exe)?$ ]]; then
      local inner="${seg//\"/}"; inner="${inner//\'/}"
      [[ "$inner" =~ [[:space:]][-/][cC][[:space:]]+(.*)$ ]] || continue
      inner="${BASH_REMATCH[1]}"
      while IFS= read -r sub || [[ -n "$sub" ]]; do
        [[ -z "${sub//[[:space:]]/}" ]] && continue
        is_force_push_to_protected "$sub" \
          && block "force-push to a protected branch [$(echo "$sub" | tr -s '[:space:]' ' ')]"
      done < <(split_segments "$inner")
    fi
  done < <(split_segments "$text")
}

scan_for_force_push "$(printf '%s' "$COMMAND" | strip_heredoc_bodies)"

exit 0
