---
labels: [defect]
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
`max` is session-scoped per the SDK typing (`@anthropic-ai/claude-agent-sdk` 0.3.246) and did not appear in `get_settings`'s `effective` or `sources` in that run, so check it survives whatever path is chosen.

## Done when

- A test resumes a Claude Code conversation whose store's last assistant line records a model and effort and asserts the CLI is told that effort before the first turn, and that model unless the CLI was measured restoring it, shown red first.
- A test forks such a conversation and asserts the fork's process is told the parent's effort, shown red first.
