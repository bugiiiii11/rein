---
name: handoff
description: Session lifecycle -- "/handoff start" (session briefing), "/handoff wrap" (update handoff.md + local commit), "/handoff save" (emergency snapshot), "/handoff docs" (docs-only update)
---

# Handoff -- session lifecycle (v3)

One skill, four subcommands. Detect the mode from the argument: `start`, `wrap`, `save`, `docs`. No argument -> reply with one usage line listing the four modes and stop.

## CONFIG (all modes)

- Output language: English. No emojis in docs.
- Repo mode: single repo at project root (branch `main`).
- Files (project root): `handoff.md` (live state -- HARD CAP ~120 lines, max 2 session sections, Session Summary max 10 rows, Key Files max 10 rows), `handoff-archive.md` (overflow, newest first -- NEVER read during start), `emergency-snapshot.md` (fire exit).
- Wrap is AUTOMATIC: update handoff.md, rotate overflow, commit locally -- no confirmations. NEVER push without an explicit user request.
- AUTO-WRAP RULE: the Stop hook fires at ~15% of the context window (hard nudge at 17%). When it fires -- or you independently notice context getting long -- finish the task at hand, then run the full wrap flow unasked.
- If CLAUDE.md defines project-specific "Handoff extras" (e.g. a wiki/vault sync), honor them during wrap.

## Token discipline (the point of this design)

- start reads ONLY `handoff.md` (+ the snapshot if present). Never the archive, knowledge folders, or CLAUDE.md (auto-loaded).
- Need history mid-session? Read `handoff-archive.md` at that moment, never preemptively.
- Record in handoff.md only what git CANNOT tell a future session: decisions, rejected approaches and why, gotchas, open questions. Never re-list changed files or restate commit messages.

## Mode: start

Read-only (single exception: delete a consumed snapshot).

1. In parallel: read `handoff.md`; run `git status -sb`, `git log --oneline -5`, `git rev-list @{u}..HEAD --count` (no upstream or error -> treat as 0; no `.git/` -> skip git, note it).
2. If `emergency-snapshot.md` exists: read it, fold it into the briefing, delete it after presenting (it is consumed).
3. Present the briefing, max ~25 lines total:

```
## Session Briefing
**Last session:** <N> -- <title from handoff.md>

### Repo Status
| Branch | Status | Unpushed | Last commit |

### What To Do Next (top 5)
<top 5 rows of the handoff table; flag rows that look already done per git log>

### Emergency Recovery (only if snapshot existed -- max 5 lines)

### Heads Up
<uncommitted/unpushed work, stale items; handoff.md over ~150 lines means the
last rotation failed -- flag it and offer to rotate now. Else: "All clear.">
```

- If `handoff.md` is missing: say so and suggest `/handoff wrap` to create it from the template below.

## Mode: wrap

ORDER MATTERS: documentation is updated BEFORE the commit, so the wrap commit includes the handoff it wrote and the repo is left clean.

1. Assess (parallel): `git status -sb`, `git diff --stat`, `git rev-list @{u}..HEAD --count`. Skip re-reading handoff.md if it is already in context this session.
2. Update `handoff.md` automatically:
   - Same-session idempotency: if a "What Was Done (Session N)" section for THIS working session already exists (e.g. an auto-wrap ran earlier in this chat), UPDATE it in place -- never create a duplicate. Otherwise N = last Session Summary row + 1.
   - New section goes BEFORE "What To Do Next": `## What Was Done (Session N) -- <short title>` with terse bullets, max 8. Convert relative dates to absolute.
   - Refresh: Current State; What To Do Next (drop completed rows); Key Files only if a file matters for the NEXT steps (prune to max 10 rows); this session's Session Summary row.
   - Touch CLAUDE.md only if the project phase or strategy genuinely changed (rare).
3. Rotate overflow: if more than 2 session sections OR over ~120 lines, move the oldest "What Was Done" sections to `handoff-archive.md` (newest at TOP, under heading `# Handoff Archive (do not read on /start)`; create the file on first rotation; append-only -- never trim it). Session Summary over 10 rows -> move oldest rows to the archive's own table.
4. Commit locally: review `git status` briefly, then `git add -A` and commit with a descriptive message. Leave out junk or abandoned experiments and mention them. Do NOT push.
5. Report, max 10 lines: commit hash + message, what "What To Do Next" now says, rotation yes/no, warnings. No questions. If everything was already clean and current: "All wrapped. Nothing to do."

## Mode: save

Fire exit -- max 6 tool calls, no commit, no reads except `git status -sb`. Write from what is already in context, fast, then stop. Create/overwrite `emergency-snapshot.md`:

```markdown
# Emergency Snapshot -- Session <N>
Date: <today>

## What was done this session
## Uncommitted work            <- from git status, or "all clean"
## Key context                 <- root causes, decisions, gotchas that would otherwise be lost
## Next step when resuming
```

`/handoff start` consumes and deletes this file next session.

## Mode: docs

Run wrap steps 2-3 only (update + rotate). No commit.

## handoff.md template (first wrap, if the file is missing)

```markdown
# <Project> -- Handoff

<!-- HARD CAP ~120 lines. Max 2 session sections. Overflow -> handoff-archive.md -->

## Current State

- **Phase:** <phase>
- **Session count:** <N>
- **Repo status:** <status>

## What Was Done (Session N) -- <short title>

- <bullet>

## What To Do Next

| # | Priority | Task |
|---|----------|------|
| 1 | High | <task> |

## Key Files

| File | Purpose |
|------|---------|
| `handoff.md` | Current state + next steps (capped; history in handoff-archive.md) |

## Session Summary

| Session | Date | Title |
|---------|------|-------|
| 1 | <date> | <title> |
```
