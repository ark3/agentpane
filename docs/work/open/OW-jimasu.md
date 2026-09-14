---
labels: [deferral]
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
