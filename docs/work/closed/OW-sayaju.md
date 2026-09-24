---
labels: [defect]
closed: done
---

# A chosen Codex effort is lost when the conversation is reopened after its app-server exits, and a fork never inherits it

OW-kokalo lets a client choose a Codex conversation's reasoning effort before the first prompt, and the clients then fix it: no client offers the choice again once a message exists.
So an effort that silently reverts cannot be put back, and the conversation runs and reports the default from then on.

## Measured: a reopen runs at the default

`docs/MANUAL_TESTING.md`, "A Codex turn at a chosen reasoning effort, and what a resume keeps of it (OW-kokalo)", measured on the home server 2026-09-23 with `codex-cli 0.156.0` and `gpt-5.6-luna`.
An effort sent on one `turn/start` carried to later turns on the same app-server, but a `thread/resume` in a fresh app-server answered `reasoningEffort: "medium"`, the default, and the next turn sent without an effort ran at `medium`.
`ThreadResumeParams` has no effort field (`resources/codex-protocol/v2/`).

The adapter holds the chosen effort only in memory: `private effort` in `src/server/adapters/codex/adapter.ts`, whose docblock records the above.
A `DELETE` then re-attach, or a server restart, builds a new `CodexAdapter` whose `effort` is null, so nothing is sent on `turn/start` and `getState` reports the thread's own `reasoningEffort`.

## Read, not measured: a fork starts with neither the effort nor the model

`fork()` in `src/server/adapters/codex/adapter.ts` builds the fork's adapter as `new CodexAdapter(forkRef, this.options)` and returns `start: { cwd, resumeId }`, so the borrower holds no `effort` and no `model`, and its turns send neither.
What the forked thread then runs at is unmeasured: the override lived on the parent thread, and whether `thread/fork` copies it is not recorded anywhere.
The model half of this is the same gap, and OW-pubulu is its Pi twin for a resumed spawn.

## Load-bearing

A conversation whose effort was chosen keeps running at that effort, and its turns name it, across a reopen and into a fork -- or, where Codex cannot be made to, the clients stop pretending the choice is fixed.
D23 in `docs/DESIGN.md` settles the source: the model and effort the rollout's last `turn_context` recorded, re-asserted by the adapter, never a copy agentpane keeps.
The model half is unmeasured -- whether a `thread/resume` with no `model` restores the thread's own -- so measure it with the effort and apply D23 to whichever Codex does not restore.
How the adapter reads the rollout is incidental.
Two related unknowns from the same run belong to whoever works this: a resume on the app-server that still holds the thread, and a model change with no chosen effort, where the thread's reported effort may not be one the new model lists.

## Done when

- A test reopens a Codex conversation whose rollout's last `turn_context` records a model and effort and asserts the next `turn/start` carries that effort, and that model unless Codex was measured restoring it, shown red first.
- A test forks such a conversation and asserts the fork's first `turn/start` carries the parent's effort and model, shown red first -- or a live run records in `docs/MANUAL_TESTING.md` that `thread/fork` already carries the override, with the `codex-cli` version, and the test asserts what the adapter relies on instead.

## Close note

A Codex resume, and a fork's borrower, now read the model and effort the rollout's last `turn_context` recorded and re-assert them per D23: the effort on every `turn/start`, the model in place of the one the resume answered unless a model was given at start.
A fork is read through its `history_base`, so it takes its kept prefix's last turn, not the parent's latest.
The reader is `readCodexLastTurnSettings` in `src/server/sessions/codex.ts`, the preview's walk keeping only `turn_context`; `CodexAdapterOptions.codexRoot` lets tests point it at a throwaway store instead of `~/.codex/sessions`.
The stored model rides `turn/start` only, never `thread/resume`, because naming a model on a resume resets the effort.

Measured on the home server 2026-09-23, `codex-cli 0.156.0`, two turns on `gpt-5.6-luna`, with the config set to `gpt-5.6-terra` at `high` so thread, config and model default differed (`docs/MANUAL_TESTING.md`, "What model and effort a Codex resume and fork run at (OW-sayaju)"):
a `thread/resume` naming no model restores the thread's model and effort, fresh or on the holding app-server; a resume naming the model resets the effort to the config's and records that, so a later bare resume restores the reset, not the last turn; `thread/fork` carries neither, answering the config's pair, and a turn on it ran at the config's effort.
That overturned OW-kokalo's reading ("an override lasts as long as the app-server"); its section, the `private effort` docblock and D23's Codex row and model sentence in `docs/DESIGN.md` were corrected.

Tests in `src/server/adapters/codex/adapter.test.ts`: "resumes at the effort the rollout's last turn ran at, not the one the resume reports (D23)" and "starts a fork at the model and effort the kept prefix's last turn ran at (D23)", both red with the adoption removed (re-checked by the dispatching session), the fork test also red with the prefix bound removed; `bun run check` green on main, 1229 tests.
Not isolated: whether `turn/start` naming a model with no effort resets the effort; no fork cut at an earlier turn was run live.
Findings the run surfaced were already carded: OW-hojefo (first-turn fork sends no `lastTurnId`), OW-9 (`setModel` leaves the reducer's model stale), OW-siboja (index ignores `CODEX_HOME`).
