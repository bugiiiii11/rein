---
description: Wrap session -- assess state, commit/push, update docs. Use `/wrap emergency` for fast snapshot or `/wrap docs` for docs-only update.
---

## CONFIG

- **Output language:** English
- **Repo mode:** single-repo at project root
- **Push command:** `git push` (uses upstream tracking)
- **Handoff file:** `handoff.md` at project root
- **Emergency snapshot file:** `emergency-snapshot.md` at project root

---

Respond to the user in the language set in CONFIG above.

Wrap up the current session based on the mode requested. Three modes:

- `/wrap` (default) -- full wrap: check state, commit & push (with confirmation), update handoff.md
- `/wrap emergency` -- fast snapshot to `emergency-snapshot.md`, no questions, max 6 tool calls
- `/wrap docs` -- only update documentation (no commit/push)

Detect the mode from the argument the user passed after `/wrap`.

---

## Mode: emergency

If user invoked `/wrap emergency`:

Run in parallel:
- `git status -sb`

Then create/overwrite `emergency-snapshot.md` in project root with:

```markdown
# Emergency Snapshot -- Session <N>
Date: <today>

## What was done this session
<Bullet list of what was accomplished, decisions made, files changed>

## Uncommitted work
<List of modified/new files from git status, or "all clean">

## Key context
<Anything important that would be lost -- root causes, approaches decided, gotchas>

## Next step when resuming
<What was in progress or about to start>
```

**Emergency rules (strict):**
- Max 6 tool calls total (status + write)
- Do NOT commit, push, or update other docs
- Do NOT read handoff.md or other files -- use what you know from conversation
- This is a fire exit. Write fast, then stop.
- If snapshot exists, overwrite it (new one is more current)

---

## Mode: docs

If user invoked `/wrap docs`:

Skip to "Step 3 -- Update documentation". No commits.

---

## Mode: default (full wrap)

### Step 1 -- Assess current state (parallel)

- `git status -sb`
- `git diff --stat`
- `git rev-list @{u}..HEAD --count` (treat error / no upstream as 0)

Read `handoff.md` -- is the current session documented? Is "What To Do Next" accurate? (If file is missing, note this -- Step 3 will create it.)

### Step 2 -- Report and act on code changes

Present brief status:

```
## Wrap Check

### Status
| Branch | Uncommitted | Unpushed | Action? |
|--------|-------------|----------|---------|
| <branch> | <files or "clean"> | <N or 0> | <yes/no> |

**Handoff status:** <up to date / needs session N section / stale / missing>
```

**Code changes (commit & push):**
- If uncommitted changes exist:
  - Show changed files
  - Ask: "Want me to commit & push?"
  - If yes, follow standard git commit protocol, then `git push` to upstream
  - Treat commit & push as one action unless user says otherwise
- NEVER auto-commit. Always ask first.

### Step 3 -- Update documentation

**Smart assessment** -- before reading files, think about what actually changed this session:
- Any work done? -> always check `handoff.md`
- Strategic decisions? -> check `CLAUDE.md` (if exists)
- New stable technical facts? -> check `.claude/reference.md` (if exists)
- Otherwise -> skip

Only read files that might need updating. Skip the rest.

Report assessment:

```
Documentation check:
- handoff.md: <needs update / up to date>
- CLAUDE.md: <needs update / skipped / N/A>
- .claude/reference.md: <needs update / skipped / N/A>

Update? (N files)
```

If everything is up to date, say so clearly and stop.

#### handoff.md updates

If `handoff.md` is missing, create it from the template at the bottom of this file (fill in current state).

Otherwise, add a new session section BEFORE "What To Do Next":

```markdown
## What Was Done (Session N) -- <short title>

1. **<What was built/changed>** -- <description>. Files: <list>. Committed: <hash if applicable>.
```

Then update:
- "What To Do Next" table to reflect current priorities (flag/remove completed items)
- "Key Files" table if new files were added
- Session Summary table -- add row for this session

**Trimming:** If handoff has more than ~3 session sections, move oldest to an archive section at the bottom (or delete if trivial).

#### CLAUDE.md (rarely)

- Update "Current State" section if session number or project status changed
- Keep concise -- target under 80 lines

#### .claude/reference.md (rarely)

- Update if tech stack, repo structure, or deployment changed
- Update "Last Updated" date

## Rules

- Always ask before committing, pushing, or modifying docs
- If everything is clean and up to date, say "All wrapped. Nothing to do." and stop
- Keep it brief
- Idempotent -- safe to call multiple times
- No emojis in docs

---

## handoff.md template (used on first /wrap if file is missing)

```markdown
# <Project Name> -- Project Handoff

Project: <short description>
Started: <today>

## Current State

- **Phase:** <phase>
- **Session count:** <N>
- **Repo status:** <status>

## What To Do Next

| # | Priority | Task |
|---|----------|------|
| 1 | High | <task> |

## Key Files

| File | Purpose |
|------|---------|
| `handoff.md` | Session history + next steps |
| `.claude/commands/start.md` | /start slash command |
| `.claude/commands/wrap.md` | /wrap slash command (default/emergency/docs modes) |

## Session Summary

| Session | Date | Title |
|---------|------|-------|
| 1 | <date> | <title> |
```
