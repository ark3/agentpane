---
labels: [defect, now]
closed: done
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

## The fix, and why the other one is declined

Measured 2026-09-15 by `resources/probes/codex_fork_same_process_probe.py`, same CLI version (`docs/MANUAL_TESTING.md`, "The app-server that mints a fork can also drive it, and keep the parent"): in the process that minted the fork, `thread/resume` on it succeeds, `turn/start` against it completes, and the parent thread is still drivable afterwards in that same process.
A second process is refused there too, with JSON-RPC `-32600` -- a decision, not a transport failure.

So the fork's adapter must borrow the parent's client instead of spawning its own.
The demultiplexing this needs already exists: `src/server/adapters/codex/reducer.ts` drops any notification whose `threadId` is not its own, and `CodexAdapter.onServerMessage` does the same on the `turn/started` and `turn/completed` arms, so two adapters on one client already ignore each other's traffic.
What does not exist is the lifetime: `ClientOwnership` and `dispose()` assume the adapter owns the child and kill it, so a borrowed client needs a refcount or a host object such that disposing the borrower leaves the owner's agent alive and disposing the owner does not strand the borrower.
The manager needs the matching seam -- `#pendingForks` carries `StartOptions` for a fork that exists only as arguments, and this case has to carry a live handle instead, with `SessionManager.#start` able to start an adapter that spawns nothing.
`onExit` also fans out to one adapter today, and one dead child now ends two sessions.

Disposing the parent at fork time was the cheap alternative and is **declined**: nothing needs the parent's process to go away, and it would make agentpane destroy a turn OW-gojado measured surviving on this very version, which is exactly what D15 was reframed on 2026-09-13 to stop.

## Done

`resources/probes/fork_attach_probe.py --backend codex` runs green -- its `fork_last_turn` step reaching `attach_http: 200` and a turn landing in the fork -- against a `codex-cli` whose version the run records, and the new evidence replaces the section this card cites rather than being filed under it.
The three stale copies of OW-22's inference are already corrected (`codex/adapter.ts` `fork`, the `fork` route in `http/app.ts`, and `ForkResult` in `adapters/types.ts`); any fix has to leave those true.

## Close note

Fixed by letting a Codex fork's adapter borrow the parent's `codex app-server` instead of spawning its own, which is the fix this card specified on the evidence in `docs/MANUAL_TESTING.md`, "The app-server that mints a fork can also drive it, and keep the parent".
The declined alternative -- disposing the parent at fork time -- stayed declined.

Three commits on `main`: `1effa26` (the adapter and the new connection), `92a1bbb` (the manager seam), `4f10121` (routing and started-ness corrections found in review).

## What was built

`src/server/adapters/codex/connection.ts` is new: `CodexConnection` owns one `codex app-server` child and one `CodexClient` -- one JSON-RPC id space -- and hands each adapter a `CodexConnectionHolder` wearing the `CodexClientView` face, so an adapter cannot tell a borrowed connection from an owned one.
Release is refcounted over N holders, not a parent/child pair, because a fork of a fork sends `thread/fork` over the same connection; only the last holder out disposes the client and kills the child.
`CodexAdapter.fork()` builds the borrower itself and hands it back on `ForkResult`, now a three-arm union so an `adapter` without a `start` -- which would be silently dropped, never started, never disposed -- cannot be expressed.
`SessionManager` parks that live handle in `#pendingForks` and `#start` starts it instead of asking the factory; `close()` and `disposeAll()` dispose a parked handle rather than dropping it, because an abandoned handle holds a share where an abandoned recipe held three strings.

Three subtleties that were not in the card and are worth knowing if this is revisited.
The share is taken synchronously at fork time, not at attach, which is what makes `close(parent)` racing `attach(fork)` safe -- `#disposing` is keyed per session and does not gate the other.
The borrower's reducer identity is seeded in `adoptConnection` before it joins the line stream, because `CodexReducer.handleNotification`'s cross-thread guard fails OPEN while `threadId` is null, so an unseeded borrower would take a streaming parent's deltas as its own -- the D15/OW-gojado case.
A `ServerRequest` is routed to exactly one holder rather than fanned out, or two sessions draw one approval and the second reply writes a second JSON-RPC response for one wire id; it goes to the holder whose thread it names -- reading `conversationId` as well as `threadId`, since the two deprecated approval kinds name the thread that way -- and otherwise to the first holder that has been started, never to a parked borrower nobody has subscribed to.

## How it was verified

`bun run check` green at 1091 tests, up 6.
Thirteen new tests across `src/server/adapters/codex/adapter.test.ts` (describe "CodexAdapter borrowed connection (OW-lajehi)") and `src/server/http/session-manager.test.ts` (describe "a fork that shares the parent's subprocess (OW-lajehi)").
Six guards were mutation-verified by the dispatching session independently of the implementer's own runs: removing the identity seeding, fanning requests to all holders, killing on every release, dropping the `conversationId` read, dropping the `answerable` filter, and dropping the `startCalled` half of `requireClient` each reddens a named test and nothing else.

The done-condition ran live: `resources/probes/fork_attach_probe.py --backend codex` on the home server 2026-09-15 against `codex-cli 0.154.0`, every step passing -- `fork_http` 201, `attach_http` 200, a turn landing in the fork, the re-attach, the fork of the fork, and a second fork of the parent, parent still attachable, no orphaned workers, the fork's transcript correctly truncated.
Written up in `docs/MANUAL_TESTING.md` by replacing the Codex verdict in "Forking the most recent turn and attaching the fork, on all three backends", as this card asked, rather than filing a new section under it.

## What it does not cover

Closing one side of a fork pair and re-attaching it while the other still lives is still refused with `already has an active writer`: nothing releases the closed side's thread, so `#start` takes the factory path into a second app-server.
That is **OW-voyezi**, filed during this execution, and it includes the unmeasured question its fix turns on -- whether `thread/unsubscribe`, which exists in the protocol and agentpane never sends, releases the writer lock.
