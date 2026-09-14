---
labels: [deferral]
closed: done
---

# disposeAll leaves the same #adoptRef-after-teardown window OW-yavewa closed for close()

Surfaced during OW-yavewa's implementation and deliberately left alone there; read, not run.

OW-yavewa gave `ManagedSession` a `torndown` flag that `close()` sets before its first await and `#adoptRef` reads, so a `submit()`/`fork()` whose `finally` runs after teardown no longer re-keys a disposed container back into `#sessions`.

`disposeAll()` in `src/server/http/session-manager.ts` takes the other teardown path and sets no such flag.
It clears `#sessions` wholesale -- the block commented "First, and before any await: the tables below are walked exactly once" -- and flags only the `PendingStart` records in `#attaching`.
A `fork()` or `submit()` already parked in its adapter round trip when shutdown begins reaches `#adoptRef` afterwards, finds `session.torndown` unset, and inserts the disposed container into the map that was just cleared, then broadcasts.

## Why it was not fixed with OW-yavewa

The consequence is bounded in a way the `close()` case is not.
`#shuttingDown` makes `attach` throw `ServerShuttingDownError`, so nothing hands the re-inserted entry back out the way `liveRefs()` and `attach` did for the closed-session case, and the process is on its way out.
That leaves a map entry nobody reads, in a server that is exiting -- which is why a guard here risks being exactly the check nothing can trigger that AGENTS.md warns against.

## What has to be settled

Whether anything observable follows from that entry between `disposeAll()`'s walk and process exit: the HTTP server keeps serving for the whole of shutdown (`src/server/index.ts` stops the socket after closing the app), so the question is whether any route still reachable in that window reads `#sessions` without going through `attach` -- `list()`, `#liveOverlay`, `adapterFor`, `isAttached`, and the broadcaster's snapshot source are the candidates, all in `session-manager.ts`.

## Done when

Either a test in `src/server/http/session-manager.test.ts` drives `disposeAll()` concurrently with a gated `fork()` and asserts whatever observable was found to be damaged, going red first and green after a fix -- the OW-yavewa test `"does not re-key a session that was closed while its fork was in flight"` is the pattern for gating the adapter call -- or this card closes `--declined` with the reachability reasoning recorded, naming the routes that were checked and found not to read the table in that window.

## Close note

Fixed, in ddcd24f on `main`: `disposeAll()` now sets `torndown` on every `ManagedSession` in its snapshot, before its first await, symmetric with `close()`, so `#adoptRef`'s existing guard covers both teardown paths.

The card asked first whether anything observable follows from the re-inserted entry, and the answer is yes -- the counter-argument it recorded (that `#shuttingDown` stops `attach` handing it back out) does not hold, because `attach` is not the only way out.
`liveRefs()` is reached from `GET /api/events` via `broadcaster.sendOpeningSnapshots` in `src/server/http/app.ts`, with no shutdown guard anywhere on that path; `adapterFor()` is reached from the `abort` and `compact` routes via `requireAttached`, likewise without `attach`.
`app.close()` does run `broadcaster.closeAll()` before `disposeAll()`, so the clients connected at SIGTERM are cut -- but `addClient` has no guard and the stream writes `retry: 500`, so a browser reconnects into the shutdown window and is served a full snapshot of a session whose subprocess is dead.
That is exactly the harm `#adoptRef`'s own docblock names ("where `liveRefs()` hands it to every reconnecting client"), which it claimed was guarded for both callers and was not.

Verified by `"does not re-key a session that was disposed while its fork was in flight"` in `src/server/http/session-manager.test.ts`, the existing `close()` test of the same window with `disposeAll()` in its place, gating the fake adapter's `fork` on a `deferred()`.
Shown red first with the fix line removed -- it fails on `expect(sessions.liveRefs()).toEqual([])`, returning the fork's re-keyed id -- and green with it.
The fake's default `forkMode: "pi"` is load-bearing: on the other modes the adapter's ref never moves and `#adoptRef` returns at `oldKey === newKey`, proving nothing.
`bun run check` clean on `main`: 49 files, 1066 tests.

Filed OW-luwowo for what this does not fix: no route but `attach` consults `#shuttingDown`, so `/api/events`, `GET /api/sessions`, `abort`, `compact` and `DELETE` all serve normally for the whole of shutdown.
