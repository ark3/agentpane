---
labels: [defect]
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
Where the effort is persisted, or whether it is re-derived from the rollout's last `turn_context` record, is incidental.
Two related unknowns from the same run belong to whoever works this: a resume on the app-server that still holds the thread, and a model change with no chosen effort, where the thread's reported effort may not be one the new model lists.

## Done when

- A test reopens a Codex conversation whose effort was chosen and asserts the next `turn/start` carries that effort, shown red first.
- A test forks such a conversation and asserts the fork's first `turn/start` carries the parent's effort and model, shown red first -- or a live run records in `docs/MANUAL_TESTING.md` that `thread/fork` already carries the override, with the `codex-cli` version, and the test asserts what the adapter relies on instead.
