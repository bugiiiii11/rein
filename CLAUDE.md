# Rein

The control plane for AI agent payments (x402 / ERC-8004 stack). Non-custodial: it governs an agent's authority to spend, not the funds. Phases: Guard (spend control + observability), Gate (vendor monetization middleware), Graph (reputation).

## Session protocol

- Start each session with `/handoff start` (reads `handoff.md`). Other modes: `/handoff wrap`, `/handoff save`, `/handoff docs` -- see `.claude/skills/handoff/SKILL.md`.
- **AUTO-WRAP RULE:** the auto-wrap Stop hook measures REAL context usage from the transcript and fires at 15% of the window (hard nudge at 17%; window default 1M tokens, env-tunable via `AUTOWRAP_WINDOW`/`AUTOWRAP_SOFT_PCT`/`AUTOWRAP_HARD_PCT`). When it fires -- or you independently notice context is getting long -- finish the task at hand, then run the full `/handoff wrap` flow WITHOUT being asked: update `handoff.md` (no confirmation), commit locally (no confirmation), NEVER push without an explicit user request.
- Safety hooks live in `.claude/hooks/` (wired via `.claude/settings.local.json`). If a hook blocks a legitimate action, do not work around it -- explain what happened and propose a pattern fix for the user to approve.

## Conventions

- No emojis in project docs.
