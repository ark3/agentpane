---
labels: [defect]
closed: done
---

# A chosen Claude Code effort is lost on a resume and a fork, though every store line records it

OW-hokaye lets a client choose a Claude Code conversation's effort before the first prompt, and the clients then fix it, so an effort that silently reverts cannot be put back.
This is the Claude Code twin of OW-sayaju, which is Codex's.

## Measured: a resume runs at the default

`docs/MANUAL_TESTING.md`, "A Claude Code turn at a chosen effort, what `set_model` does to it, and what a resume keeps (OW-hokaye)", measured on the home server 2026-09-23 with `claude 2.1.280`.
A sonnet session whose one turn ran at `low` resumed through `ClaudeAdapter` at `applied.effort: "high"`, the model's default, while both its hydrated assistant messages carried `effort: "low"` from their store lines.
A copy of a session whose every stored turn ran at `max` resumed at `high` too, with and without `--model`, and so did a `--resume ... --fork-session --session-id <new>` spawn of it.
The adapter reports this truthfully -- `getState().effort` is read from `get_settings` at start -- so the footer shows the new level; the loss is of the choice, not of the report.

## Read, not measured

- `fork()` in `src/server/adapters/claude/adapter.ts` hands the fork's adapter `model` but no effort, and `StartOptions` in `src/server/adapters/types.ts` has no effort field.
- The real fork spawn in `src/server/adapters/claude/process.ts` passes `--resume-session-at <uuid> --fork-session`; the measured fork spawn omitted `--resume-session-at`.
- Two paths back to the chosen level are both in the same run's evidence: `--effort <level>` at spawn applied at once, and `apply_flag_settings` with `effortLevel` on the running process applied at once.
  The level to restore is on the store: each assistant line of a model with effort carries `effort` (the adapter reads it in the reducer's hydration path, `ClaudeAssistantEvent.effort` in `src/server/adapters/claude/protocol.ts`).

## Load-bearing

A Claude Code conversation whose effort was chosen keeps running at that effort, and its turns name it, across a reopen and into a fork.
D23 in `docs/DESIGN.md` settles the source: the model and effort the store's last assistant line recorded, never a copy agentpane keeps.
Whether it travels by spawn flag or control request is incidental.
The model half is unmeasured: a resume spawns with no `--model` once the manager has lost it (OW-pubulu), while `adoptModel` in `src/server/adapters/claude/adapter.ts` labels the session with the stored model, so measure what model the resumed CLI actually runs on; if it is the settings default, the label is wrong too, and D23 applies to the model as well.
Measure it with no turn: as of `claude 2.1.280`, `get_settings` answers `applied.model` with the resolved model in force (`claude-haiku-4-5-20251001` for a process spawned with `--model haiku`, probed on the home server 2026-09-23 with no turn).
That same probe read `effective.model` as `opus[1m]`, so a resume that loses its model falls back to Opus on the home server; a turn on a resume spawned without `--model` would run outside the `AGENTS.md` pin, and none is licensed here.
`max` is session-scoped per the SDK typing (`@anthropic-ai/claude-agent-sdk` 0.3.246) and did not appear in `get_settings`'s `effective` or `sources` in that run, so check it survives whatever path is chosen.

## Done when

- A test resumes a Claude Code conversation whose store's last assistant line records a model and effort and asserts the CLI is told that effort before the first turn, and that model unless the CLI was measured restoring it, shown red first.
- A test forks such a conversation and asserts the fork's process is told the parent's effort, shown red first.

## Close note

A Claude Code resume, and a fork at a real entry, now spawn with `--effort <level>` at the effort the last hydrated assistant message a model ran records -- for a fork, the kept prefix's -- per D23; a `<synthetic>` assistant line the CLI writes itself (a session-limit notice, `isApiErrorMessage: true`, no `effort`) is skipped for both the effort and the stored model, since a resume after a session limit is exactly when such a line is last.
`effort` is a new `ClaudeSpawnOptions` field in `src/server/adapters/claude/process.ts`; `StartOptions` is unchanged.
The spawn flag was chosen over `apply_flag_settings` after attach because it is in force from the process's first instant; both were measured to hold the level.

Measured on the home server 2026-09-23, `claude 2.1.280`, no turn (`docs/MANUAL_TESTING.md`, "What model and effort a Claude Code resume and fork run at, and how the effort is put back (OW-nabano)"): every resume or fork without an effort read `applied.effort: "high"`; `--effort low` and `--effort max` read back `low` and `max` on a resume and a fork, `max` included though no settings source names it; `--effort bogus` was ignored; a later `apply_flag_settings` still overrides the flag.
The model half needed no code: a `--resume` and a `--fork-session` spawn of a sonnet session with no `--model` put the store's `claude-sonnet-5` in force over the settings' `opus[1m]`, and the existing tests already pin the stored model on the resume spawn (dropping it turned 8 red).
That the adapter still passes `--model` anyway, overriding the CLI's own restore (observably, it drops `[1m]` on an opus session), is OW-tebibo; a `user` event seen on each `set_model` in the same run is OW-hiligu.

Tests in `src/server/adapters/claude/adapter.test.ts` (resume at the stored model and effort; resume past a synthetic line; fork at the kept prefix's effort, not the parent's last) and `process.test.ts` (`--effort` placement), each shown red before the fix; `bun run check` green on main, 1227 tests.
