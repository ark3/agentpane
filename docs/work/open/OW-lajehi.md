---
labels: [defect, now]
---

# Forking a Codex session and attaching the fork fails with "already has an active writer", because the parent app-server still holds the forked thread

Measured on the home server 2026-09-15, `codex-cli 0.154.0`, model `gpt-5.6-luna`, through the production HTTP server by `resources/probes/fork_attach_probe.py` (see `docs/MANUAL_TESTING.md`, "Forking the most recent turn and attaching the fork, on all three backends").
Pi 0.85.1 and Claude Code 2.1.270 pass the same sequence; only Codex fails, and it fails every time.

## What happens

`POST /api/sessions/codex/<id>/fork` answers 201 with the new thread's ref, and the forked rollout is on disk within a millisecond.
The attach that follows -- `GET /api/sessions/codex/<forkId>`, the very next request `controller.ts` `forkAndSubmit` makes -- answers `500 internal_error` with the app-server's own text: `thread <forkId> already has an active writer`.
The string is the CLI's: `rg -a "already has an active writer"` over `~/.codex/packages/standalone/releases/0.154.0-x86_64-unknown-linux-musl/bin/codex` finds it beside `failed to open thread writer lock`.

The holder is the parent session's own `codex app-server` process.
The probe proves it by elimination: `DELETE /api/sessions/codex/<parentId>` answers 204, and the identical attach on the same fork ref then answers 200.

In the browser this is the whole of "edit the last message": `forkAndSubmit` throws at its `api.attach(forked)` and the `catch` publishes the app-server's sentence into the error banner, leaving the edit mode armed, the draft intact, and the fork orphaned on disk exactly as OW-puduro describes.

## Why the design expected otherwise

OW-22 settled this on `codex-cli 0.148.0` and concluded "a fresh attach on the returned ref finds it -- the index does not lag".
The disk half of that still holds; what has changed is that a *second* app-server process may no longer open a thread the first one holds.
`thread/fork` mints the fork inside the parent's process, and 0.154.0 exposes no `thread/close` or `thread/release` to hand it back: `rg -a -o "thread/[a-zA-Z]+"` over the same binary lists `start`, `resume`, `fork`, `archive` and no release verb.
Nothing here establishes which version introduced the lock; only 0.154.0 is installed on this machine, and OW-wujuda is the standing card about that version drift.

## Two directions, neither chosen

Drive the fork from the parent's app-server client rather than a new process.
Codex's app-server is multi-thread by construction and `CodexAdapter` is one-process-per-session by construction, so this is the honest fix and the expensive one: `src/server/adapters/codex/adapter.ts` would have to separate "a thread" from "a process", and `SessionManager.#start` would have to be able to start an adapter that borrows another's child.

Or release the parent before attaching the fork -- dispose the parent's adapter in `SessionManager.fork` for Codex only, the way Pi's fork already leaves the parent with no live process.
Cheap, and it costs the parent's in-flight turn, which D15 and OW-japuzo deliberately preserve on this backend; it also has to leave the parent re-attachable, since its rollout is untouched on disk.

Whichever is taken, record the reasoning in `docs/DESIGN.md` beside D15 if it changes what a fork does to the parent.

## Done

`resources/probes/fork_attach_probe.py --backend codex` runs green -- its `fork_last_turn` step reaching `attach_http: 200` and a turn landing in the fork -- against a `codex-cli` whose version the run records, and the new evidence replaces the section this card cites rather than being filed under it.
The three stale copies of OW-22's inference are already corrected (`codex/adapter.ts` `fork`, the `fork` route in `http/app.ts`, and `ForkResult` in `adapters/types.ts`); any fix has to leave those true.
