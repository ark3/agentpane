---
labels: [unverified]
closed: done
---

# The init event a Claude Code turn brings replaces the adapter's model with its own id, and nobody knows whether that id keeps the [1m] variant

Found by OW-faledu's implementer on 2026-09-23; see the "Not established" paragraph of `docs/MANUAL_TESTING.md`, "What `--model` puts a resumed Claude Code session's `[1m]` variant back in force (OW-faledu)".

## What the code does

`handleLine` in `src/server/adapters/claude/adapter.ts`, in its `event.subtype === "init"` branch, sets `this.model` to the `init` event's `model` whenever that differs, and `init` arrives with every turn.
The recorded fixtures in `resources/fixtures/claude/` carry resolved ids there (e.g. `claude-haiku-4-5-20251001`), not listed ids such as `opus[1m]` or `default`.
So after a session's first turn its label is whatever `init` reported, overriding both the listed id `listedModelFor` chose for a fresh session (OW-kakide) and the one OW-faledu's rename chose for a resumed one.

## Why it matters

`fork()` hands `this.model` to a fork at `CLAUDE_FORK_SESSION_START`, a fresh spawn that carries it as `--model`.
OW-faledu measured, as of `claude 2.1.280`, that a fresh `--model claude-opus-5-5` puts `claude-opus-5-5` in force while `opus[1m]` or `claude-opus-5-5[1m]` puts `claude-opus-5-5[1m]` in force.
If `init` reports `claude-opus-5-5` for a session running `claude-opus-5-5[1m]`, every session-start fork taken after a turn drops the variant, on fresh and resumed sessions alike, which is the defect OW-faledu fixed for the no-turn case.
If it reports `claude-opus-5-5[1m]`, the fork is right and only the label differs from the picker's id.

## The measurement and its constraint

What is unknown is the `init` event's `model` on a turn running a `[1m]` model.
Measuring it needs one turn on such a model, and `AGENTS.md`, "Evidence", licenses turns in an agent session only on haiku, which has no `[1m]` variant.
So this card cannot be closed by a session alone: it needs either the owner's leave for one short turn on `opus[1m]` (or `claude-sonnet-5[1m]`), or evidence from a turn the owner drove, such as an `init` line the owner captures from agentpane's own traffic.

## Done when

The `init` model for a `[1m]` turn is recorded in `docs/MANUAL_TESTING.md` with `claude --version`.
If it lacks the variant, a test in `src/server/adapters/claude/adapter.test.ts`, red first, shows a session-start fork taken after a turn spawning with a model that puts the `[1m]` variant in force; if it keeps it, the OW-faledu "Not established" sentence is retired and the close note says so.

## Close note

Measured on the home server 2026-09-23, `claude 2.1.280`, with two one-word turns on `claude-sonnet-5[1m]` under the owner's explicit leave for this card (AGENTS.md otherwise pins agent turns to haiku): a turn's `init` event names the model in force with its variant, `claude-sonnet-5[1m]`, fresh and on a resume, the same id `get_settings`'s `applied.model` reports; `message_start`, the `assistant` event and the store's assistant line name `claude-sonnet-5` without it.
So `handleLine` replacing the adapter's model with `init`'s id keeps the variant, and a session-start fork after a turn still puts it back in force (OW-faledu's table); no adapter change was needed.
A test in `src/server/adapters/claude/adapter.test.ts` pins the fork after a turn on a resumed `opus[1m]` session; it failed with the variant stripped from `init`'s id and passes on the real code.
Side finding: a resume widens the restored model by the store's `model` attachment line (`modelId: "claude-sonnet-5[1m]"`) as well as by the settings, shown on hand-edited copies; OW-tebibo's and OW-nabano's sections now say so.
Not measured: an opus turn, so `init` naming `claude-opus-5-5[1m]` is the sonnet relation applied to opus.
After a turn the label is `init`'s raw id (e.g. `claude-opus-5-5[1m]`), not a listed picker id; that is the label issue OW-kakide already noted and was left alone.
Evidence: `docs/MANUAL_TESTING.md`, "What model a Claude Code turn's `init` names on a `[1m]` session (OW-lizupu)".
