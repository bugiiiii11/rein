# Rein

The control plane for AI agent payments (x402 / ERC-8004 stack). Non-custodial: it governs an agent's authority to spend, not the funds. Phases: Guard (spend control + observability), Gate (vendor monetization middleware), Graph (reputation).

## Session protocol

- Start each session with `/handoff start` (reads `handoff.md`). Other modes: `/handoff wrap`, `/handoff save`, `/handoff docs` -- see `.claude/skills/handoff/SKILL.md`.
- **AUTO-WRAP RULE (two rungs):** the auto-wrap Stop hook measures REAL context usage from the transcript. At **20%** of the window it asks for a **checkpoint** -- run `/handoff docs` (update `handoff.md`, no commit) and KEEP WORKING. At **22%** it asks for the **full wrap** -- stop new work, update `handoff.md` and commit locally, both without confirmation, NEVER push without an explicit user request. Window default 1M tokens, env-tunable via `AUTOWRAP_WINDOW`/`AUTOWRAP_SOFT_PCT`/`AUTOWRAP_HARD_PCT`. Act on either nudge unasked -- the same applies if you independently notice context is getting long.
- Safety hooks live in `.claude/hooks/` (wired via `.claude/settings.local.json`). If a hook blocks a legitimate action, do not work around it -- explain what happened and propose a pattern fix for the user to approve.

## Conventions

- No emojis in project docs.

## Response style

- Keep answers SHORT. No long narrative, no restating context I already have.
- When something blocks me and the founder must act: lead with **numbered exact steps** (literal commands, literal URLs, literal values -- copy-pasteable, Git Bash not PowerShell 5.1). Put a one-line "why" UNDER each step, not above it.
- Separate **what I do** from **what you do**. Never bury a founder action inside prose.
- State outcomes plainly: done / failed / skipped. No hedging, no summaries of work already reported.
