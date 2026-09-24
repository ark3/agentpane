---
labels: [defect]
---

# A Claude Code resume and fork still pass --model, overriding the model the CLI restores from the store itself

D23 in `docs/DESIGN.md` ("A conversation's model and effort are read back from its store's last turn, never kept by agentpane") says that where the backend restores a value itself, agentpane's part is not to override it.
OW-nabano measured that Claude Code restores the model and agentpane overrides it anyway.

## Measured

`docs/MANUAL_TESTING.md`, "What model and effort a Claude Code resume and fork run at, and how the effort is put back (OW-nabano)", home server 2026-09-23, `claude 2.1.280`, no turn.
A `--resume` of a sonnet session with no `--model` read `applied.model: "claude-sonnet-5"` from `get_settings`, over the settings' `opus[1m]`, and a `--fork-session` spawn of it cut at its last assistant line read the same.
The owner's opus session, resumed with no `--model`, read `claude-opus-5-5[1m]`; with `--model claude-opus-5-5`, the id its store lines record, it read `claude-opus-5-5`.
So the override is observable: passing the stored id drops the `[1m]` variant the CLI would otherwise have restored, though `get_context_usage` reported `maxTokens: 1000000` both ways in that run.
That section's "Not established" paragraph says what the run could not separate: whether the CLI restores the store line's id or a model it records elsewhere, since the owner's settings named the same model family.

## The code

- `adoptStoredModel()` in `src/server/adapters/claude/adapter.ts` sets `this.model` from `lastHydratedAssistant()` before `attachProcess`, and `attachProcess` passes `this.model` to the spawner as `--model`, so every resume and every fork at a real entry spawns with one.
- `fork()` in the same file puts the parent adapter's live `this.model` into the fork's `StartOptions`, so `adoptStoredModel()` never runs for a fork, while the fork's effort now comes from the kept prefix (OW-nabano).
  A fork at an earlier entry of a session whose model changed later -- possible through `/model` in a session started outside agentpane, which D23 says it covers -- spawns with the parent's latest model and the prefix's effort.
- The adapter's module docblock, in the bullet that opens "A chosen effort is set on the running process", records that the adapter "nonetheless still passes one" and makes no claim either way; this card is where that gets decided.

## Found alongside

After a resume, `this.model` is the store's resolved id (`claude-sonnet-5`), not a listed picker id (`sonnet`), because `listedModelFor` only runs while no model is known (the module docblock bullet that opens "A session nobody chose a model on").
The clients fix the model after the first prompt, so this is a label, not a choice lost; decide here whether it matters, and record the decision in the close note.

## Load-bearing

That a resumed or forked Claude Code conversation runs on the model its store's last turn recorded, `[1m]` variant included, and its label names it.
Incidental: whether that is reached by passing no `--model` on a resume and fork, or by passing a better id.
Measure before choosing, with no turn: a resume whose store records one model while the settings name a different family, spawned without `--model`, read back through `get_settings`'s `applied.model`, which settles the question that section left open.
A turn is not needed and is not licensed off haiku (`AGENTS.md`, "Evidence").

## Done when

A test in `src/server/adapters/claude/adapter.test.ts`, red first, asserts the resume and fork-at-entry spawns carry whatever the measurement licenses: no `model` where the CLI was shown to restore it, or the id that puts the recorded model in force.
The measurement is recorded in `docs/MANUAL_TESTING.md`, and the module docblock sentence above says what the code now does.
