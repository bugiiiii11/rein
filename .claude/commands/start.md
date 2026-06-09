---
description: Session initialization -- read project state, show what's next, flag anything stale or uncommitted
---

## CONFIG

- **Output language:** English
- **Repo mode:** single-repo at project root
- **Handoff file:** `handoff.md` at project root
- **Emergency snapshot file:** `emergency-snapshot.md` at project root

---

Respond to the user in the language set in CONFIG above.

Initialize the session by reading project state and presenting a clear starting point.

## Step 1 -- Read project context (do in parallel)

Read this file:
- `handoff.md` (project root) -- session history + "What To Do Next"

Note: `CLAUDE.md` (if it exists) is auto-loaded by Claude Code -- do NOT read it again.

Run these in parallel (single-repo mode):
- `git status -sb`
- `git log --oneline -5`
- `git rev-list @{u}..HEAD --count` -- unpushed count (errors silently if no upstream -> treat as 0)

If git repo isn't initialized (no `.git/`), skip git commands and note this in the briefing.

Check if emergency snapshot exists:
- `emergency-snapshot.md` (project root)
- If it exists, read it and include its contents in the briefing under "Emergency Recovery"
- After presenting the briefing, delete the snapshot file (it's been consumed)

## Step 2 -- Present session briefing

Show a concise briefing using this structure (translate labels to CONFIG language):

```
## Session Briefing

**Last session:** <N> -- <title from handoff.md>

### Repo Status
| Branch | Status | Unpushed | Last commit |
|--------|--------|----------|-------------|
| <branch> | <clean/dirty + N files> | <N or 0> | <hash> <msg> |

### What To Do Next
<Copy "What To Do Next" table from handoff.md>
<Flag items that look already done based on git log or file presence>

### Emergency Recovery (only if snapshot existed)
<Summary of what was in progress -- key points from the snapshot>

### Heads Up
<Uncommitted work, unpushed commits, stale handoff items>
<If nothing: "All clear.">
```

## Rules

- Do NOT make any changes (the only exception: delete `emergency-snapshot.md` after consuming it)
- Keep the briefing short and scannable
- Flag stale items honestly -- if a "What To Do Next" task looks already complete, say so
- If `handoff.md` doesn't exist yet, note this and suggest running `/wrap` to create it from template
