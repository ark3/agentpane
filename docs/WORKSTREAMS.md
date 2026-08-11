# Workstreams

The build is split into slices. They were originally built **in parallel**,
each in its own git worktree; that phase is over — the parallel agents were
killed by an account session limit, and the work now continues **one slice at a
time**.

This document is the current state of each slice and the order to pick them up.
Read `HANDOFF.md` and `DESIGN.md` first — they carry the decisions and the
evidence; this only says what is built, what is left, and in what order.

## Status (2026-08-11)

| Slice | State | Where |
|---|---|---|
| session-index | **done, verified** — 32 tests | merged to `main` |
| pi-adapter | **done, verified** — `bun run check` green, 107 tests; two gaps below | branch `pi-adapter` |
| transport | unverified — `check` green, 90 tests, never reviewed | branch `wip/transport` |
| renderer | unverified — 2 failing tests, typecheck clean | branch `wip/renderer` |
| codex-adapter | unverified — ~4 `TS2345` errors in `reducer.test.ts` | branch `wip/codex-adapter` |
| client-shell | not started | — |

**A green `bun run check` is not verification.** `wip/pi-adapter` passed on
merge — and its largest file, the 293-line process shell, had no tests at all
and held four real defects, including one that hung `start()` forever on a
failed spawn. Read a branch before trusting its exit code.

The three remaining `wip/*` branches forked from `da6d06ca` and `main` has
moved since. Branch from `main`, merge the `wip/*` branch, then review it as
unverified code. Restarting a slice from scratch is a legitimate choice if the
partial work looks more confusing than helpful — say so rather than forcing it.

## Pickup order

1. **pi-adapter** — close the two gaps below, merge to `main`.
2. **transport** — review it; green but unreviewed is exactly the state
   pi-adapter was in.
3. **renderer** — fix the two failures, review.
4. **client-shell** — wire the three together. `src/client/App.svelte` and
   `src/client/main.ts` are still placeholders. This is DESIGN's build-order
   step 1, the Pi-only vertical slice, and the first point at which the app
   actually runs.
5. **codex-adapter** — last, per DESIGN's build order: the `ThreadItem` →
   `AgentMessage` mapping is the only genuine engineering in the project and
   deserves to land against a UI that already works.

**Merge each slice into `main` as soon as it is green and reviewed.** The four
interrupted branches all forked from one commit and rotted against `main` while
nothing merged. That, rather than the parallelism itself, is what made them
expensive to pick up.

### Open work on pi-adapter

Both confirmed against `rpc.md` and the code; neither is implemented.

- **Resuming a session shows an empty transcript.** `start()` passes
  `--session <path>` but never fetches the existing messages — `get_messages`
  is only called from `fork()`. D3 names re-querying as *the* cold-start path,
  so attaching to any existing Pi session renders blank until a new turn.
- **A new session's real id is never learned.** `get_state` returns
  `sessionFile`; it is already typed in `protocol.ts` and discarded in
  `process.ts`. That is exactly what D9's `virtual` → materialised transition
  needs, since Pi's session id *is* its JSONL path.

## File ownership

Disjoint ownership was the defence against parallel agents colliding in the
same files. It still describes where code belongs, but it is no longer a
prohibition: **integration is now the job.**

| Slice | Owns | Verify against |
|---|---|---|
| **pi-adapter** | `src/server/adapters/pi/` | `resources/fixtures/pi/*.jsonl` |
| **codex-adapter** | `src/server/adapters/codex/` | `resources/fixtures/codex/*.jsonl` |
| **session-index** | `src/server/sessions/` | the real `~/.pi/agent/sessions` and `~/.codex/sessions` |
| **transport** | `src/server/http/`, `src/server/index.ts` | the wire contract, with a fake adapter |
| **renderer** | `src/client/render/` | hand-built `AgentMessage[]` samples |
| **client-shell** | `src/client/App.svelte`, `src/client/main.ts` | the running app |

## The shared interfaces

- `src/shared/protocol.ts` — the wire contract (D11). SSE event union, REST
  request/response types, `ROUTES`, `SessionRef`, `SessionSummary`.
- `src/server/adapters/types.ts` — `BackendAdapter`, which both adapters
  implement identically.

These were frozen so that agents who could not talk to each other could build
against them without drift. Serially that constraint is lifted: change them
when the design calls for it, but deliberately — a change ripples into every
unmerged `wip/*` branch, and `git diff main...wip/<slice>` is how you find out
how far.

## Conventions

- **Runtime is Bun**; tests are vitest. `bun install` first.
- **`bun run check` must pass** before you are done (typecheck + svelte-check +
  all tests). Not just your own tests.
- **Two test projects.** Server-side tests (`src/server/**`, `src/shared/**`)
  run in `node`; client tests (`src/client/**`) run in `jsdom`. Put the file in
  the right place rather than writing a per-file environment docblock.
- **Path aliases**: `$shared/*`, `$server/*`, `$client/*`. Imports carry real
  `.ts` extensions.
- **The pi packages are types-only** (D10). `import type` only —
  `src/import-boundaries.test.ts` fails the build otherwise, naming your file.
- Assert on **structure**, never on model wording — fixture text varies per
  capture.
- **Verify at the source**, which is HANDOFF's one rule. Where a claim about a
  CLI, a protocol, or a runtime is load-bearing, reproduce it and record how.
  The most expensive defect found so far was an unexamined assumption about
  which events `node:child_process` emits when a spawn fails.
- **A test that has never failed has not been shown to test anything.** For a
  fix, break it again and watch the test go red before you trust it.

## Recording what you find

A finding that lives only in a chat transcript dies with the session — which is
how the first round's reports were lost. Put them where they survive:

- A defect in these documents: **fix the document**, in the same change.
- A fact you had to verify: the commit message, or `DESIGN.md` when it changes
  a decision rather than confirming one.
- Something you could not resolve: DESIGN's "Remaining open questions".
