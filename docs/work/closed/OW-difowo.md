---
labels: [question]
closed: done
---

# Should a Claude Code fork before the first message carry the parent's effort, as it carries its model?

Found by OW-faledu's implementer on 2026-09-23.

`fork()` in `src/server/adapters/claude/adapter.ts` puts the parent's `this.model` into the fork's `StartOptions`, and a fork at `CLAUDE_FORK_SESSION_START` is a fresh spawn that carries it as `--model` (`chosenModel()` in `start()`).
It carries no effort: `storedEffort()` reads the kept prefix, which for a session-start fork is empty, so the fork runs at the CLI's default effort for that model (as of `claude 2.1.280`, `high` for opus and sonnet; `docs/MANUAL_TESTING.md` OW-nabano and OW-kakide).
A parent whose effort was chosen with `setEffort` before its first prompt, or whose turns ran at `low` or `max`, therefore forks at its start onto the same model at a different effort.

D23 in `docs/DESIGN.md` ("A conversation's model and effort are read back from its store's last turn, never kept by agentpane") covers forks at a real entry, whose kept prefix records an effort; it says nothing about a fork that keeps nothing, and the model is carried there anyway.
The decision is whether a session-start fork is a new conversation that starts at defaults (and then arguably should not carry the model either), or a copy of the parent's settings that should carry both; and whether Codex's and Pi's session-start forks already answer that question one way, which the answer should match.

Done when the decision is recorded in D23, and, if it changes behaviour, a card for the change is filed blocked by nothing but this one.

## Close note

Decided by the owner on 2026-09-23: a fork that keeps no turn, one cut before the first message, runs at the parent's model and effort as they stand when it is cut, as the parent's conversation begun again rather than a new one at the backend's defaults.
Recorded in D23 of `docs/DESIGN.md`, in the paragraph opening "A fork that keeps no turn".
The change is OW-sababi: Claude Code's session-start fork carried the parent's model but not its effort, and Codex's no-turn fork is to be checked; Pi forks inside the parent's process and carries both by construction.
