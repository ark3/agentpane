---
labels: [unverified]
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
