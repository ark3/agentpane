---
labels: [defect]
---

# A resumed Claude Code session names its store's resolved model id, and a fork before its first message spawns with that id, dropping the [1m] variant

Found by OW-tebibo's implementer on 2026-09-23, from the measurement in `docs/MANUAL_TESTING.md`, "Which stored model a Claude Code resume and fork restore with no `--model` (OW-tebibo)", `claude 2.1.280`.

## What happens

After a resume, `ClaudeAdapter` sets `this.model` from the last hydrated assistant message (`adoptStoredModel()` in `src/server/adapters/claude/adapter.ts`), which is the store line's `message.model`, a resolved id such as `claude-opus-5-5` or `claude-sonnet-5`, not a listed picker id such as `opus[1m]` or `sonnet`.
`listedModelFor`, which maps `get_settings`'s `applied.model` back to a listed id (module docblock bullet opening "A session nobody chose a model on"), runs only while no model is known, so it never runs on a resume.
Two consequences:

- The label: the session names `claude-opus-5-5` where the process runs `claude-opus-5-5[1m]`, since OW-tebibo measured the CLI widening a stored `claude-opus-5-5` to the settings' `[1m]` variant.
  The clients fix the model after the first prompt, so no choice is lost; it is a label that misses the variant.
- A real one: `fork()` hands the parent's `this.model` to the fork's `StartOptions`, and a fork at `CLAUDE_FORK_SESSION_START` is a fresh spawn that carries it as `--model` (`chosenModel()` in `start()`).
  On a resumed opus session under settings naming `opus[1m]`, that spawns `--model claude-opus-5-5`, which OW-tebibo's table shows puts `claude-opus-5-5` in force rather than `claude-opus-5-5[1m]`.

## Why it is not a one-liner

Leaving `this.model` null on resume so `readSettings` maps `applied.model` through `listedModelFor` was considered in OW-tebibo and not taken: that function prefers `default` where it resolves to the model in force, so a resumed opus session would be labelled `default`; it returns null for an id no listed entry resolves to; and it costs an `initialize` round trip.
A fix probably maps `applied.model` (which carries the variant) to a listed id without the `default` preference, falling back to the stored id; the exact shape is the implementer's.
Load-bearing: a session-start fork of a resumed session runs the model the parent is running, `[1m]` included; the label naming the variant is secondary.

## Done when

A test in `src/server/adapters/claude/adapter.test.ts`, red first, shows a resumed session whose `get_settings` answers `applied.model: "claude-opus-5-5[1m]"` forked at `CLAUDE_FORK_SESSION_START` spawning with a model that puts `claude-opus-5-5[1m]` in force (or with none, if a measurement shows the CLI then runs the settings' model and that is the parent's), and `getState().model` after the resume naming what the test decides the label is.
Any live measurement it needs runs with no turn off haiku (`AGENTS.md`, "Evidence") and goes in `docs/MANUAL_TESTING.md`.
