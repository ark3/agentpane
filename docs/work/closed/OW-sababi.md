---
labels: [change]
closed: done
---

# A fork before the first message runs at the parent's model and effort, not the backend's defaults

Carries out the decision OW-difowo recorded in D23 of `docs/DESIGN.md` ("A conversation's model and effort are read back from its store's last turn, never kept by agentpane"), in the paragraph opening "A fork that keeps no turn": such a fork runs at the parent's model and effort as they stand when it is cut.
Set by the owner on 2026-09-23.

## Claude Code

`fork()` in `src/server/adapters/claude/adapter.ts` puts the parent's `this.model` into the fork's `StartOptions`, but no effort.
A fork at `CLAUDE_FORK_SESSION_START` is a fresh spawn in `start()` (the `entryId === CLAUDE_FORK_SESSION_START` branch, carrying `chosenModel()`), and `storedEffort()` has no kept prefix to read, so the fork runs at the CLI's default effort (`high` for opus and sonnet as of `claude 2.1.280`).
The parent's effort in force is `this.effort`, which `readSettings` takes from `get_settings`'s `applied.effort`.
Whether the carry rides `StartOptions` (check `StartOptions` in `src/server/adapters/types.ts` or wherever the adapter contract defines it, for an existing `effort` field) or another path is the implementer's call; the spawn should carry `--effort`, which OW-nabano measured takes effect on a spawn (`docs/MANUAL_TESTING.md`, OW-nabano; as of `claude 2.1.280`).
A parent on a model without effort (haiku reads `applied.effort: null`) carries none.
A fork at a real entry keeps reading the prefix's effort (OW-nabano) and is out of scope.

## Codex

`fork()` in `src/server/adapters/codex/adapter.ts` sends `thread/fork`, with `lastTurnId` only when the fork point is past the first turn, and hands back a borrower adapter started as a plain resume, whose model and effort come from `readCodexLastTurnSettings` in `src/server/sessions/codex.ts` following the fork's `history_base`.
OW-sayaju measured (`codex-cli 0.156.0`, `docs/MANUAL_TESTING.md` OW-sayaju) that `thread/fork` itself answers `config.toml`'s pair, and that the adapter compensates from the rollout's last `turn_context`.
For a fork that keeps no turn there is no `turn_context` to read, so determine from the code (and the tests in `src/server/adapters/codex/adapter.test.ts`) what model and effort the borrower's first `turn/start` carries, and make it carry the parent's pair if it does not.
Also determine what a fork at the first fork point actually keeps when `lastTurnId` is omitted, and report it; if it keeps the whole thread rather than nothing, that is a separate defect for a new card, not this one.

## Pi

Pi forks inside the process holding the parent (`fork` in `src/server/adapters/pi/process.ts`), so it carries both by construction; nothing to do beyond confirming that in the report.

## Done when

- A test in `src/server/adapters/claude/adapter.test.ts`, red first, shows a session-start fork of a parent whose `get_settings` answered an effort spawning with that effort, and one on a parent with a null effort spawning with none.
- For Codex, either a test red first showing a no-turn fork's first `turn/start` carrying the parent's model and effort, or the report shows from the code and an existing test that it already does.
- The Claude module docblock and D23's "Applied per backend" sentence say what the code now does; `bun run check` passes.
No live run is needed: the effort flag's effect on a spawn is already measured.

## Close note

A Claude Code fork at `CLAUDE_FORK_SESSION_START` now spawns with `--effort` at the parent's effort in force when cut (`this.effort`, from the last `get_settings`), and with none for a parent whose model has no effort, per D23's "A fork that keeps no turn" (OW-difowo).
The effort rides `forkOf.effort` in `StartOptions` (`src/server/adapters/types.ts`), because only Claude's `fork()` builds `forkOf` and only its `start()` reads it, so no other start path or adapter sees a field it would silently ignore.
Two tests in `src/server/adapters/claude/adapter.test.ts` go through the real `fork()` and `start()`: the effort-carrying one failed against the old code, and the null-effort one went red with `fork()` deliberately broken to always send an effort; `bun run check` passes on main.
Codex has no fork that keeps no turn yet: at index 0 `fork()` sends no `lastTurnId`, which keeps the whole thread (OW-hojefo), so its borrower reads the parent's last `turn_context`; OW-hojefo now carries the D23 rule for whichever fix lands, and D23 says so.
Pi forks inside the parent's process and re-reads `get_state`, so it carries both by construction; nothing changed there.
