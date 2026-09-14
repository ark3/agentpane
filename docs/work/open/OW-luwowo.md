---
labels: [deferral]
---

# No route but attach refuses service during shutdown, so a reconnecting browser is served by a server that is leaving

Surfaced while executing OW-jimasu and deliberately left alone there: that card's fix removes the one observable it was filed for, and this is the gap underneath it.

`#shuttingDown` in `src/server/http/session-manager.ts` is read in exactly two places -- `attach()`, where both checks throw `ServerShuttingDownError`, and `#start`.
Nothing in `handle()` in `src/server/http/app.ts` consults it.
Every route that does not go through `attach` therefore serves normally for the whole of `disposeAll()`, and that window is not brief: `src/server/index.ts` stops the listening socket *after* closing the app, and killing one Codex child can take the full SIGTERM+SIGKILL grace.

The routes confirmed reachable in that window, traced against the source on 2026-09-13:

- `GET /api/events` -- `openEventStream` calls `broadcaster.addClient` and then `broadcaster.sendOpeningSnapshots(client, sessions.liveRefs())`.
  `addClient` has no shutdown guard of its own and writes `retry: 500`, so a browser whose stream `app.close()` just cut by `broadcaster.closeAll()` reconnects half a second later, lands mid-shutdown, and is a live client of a server that is exiting.
  With OW-jimasu's fix `liveRefs()` is empty there, so what it gets is an empty snapshot rather than a dead session -- the connection itself is the remaining defect, not its contents.
- `GET /api/sessions` -- `listSessions` calls `sessions.list()`, which reads the index off disk and answers 200.
- `POST .../abort` and `POST .../compact` -- both reach `requireAttached`, which calls `adapterFor` and never `attach`.
- `DELETE /api/sessions/:backend/:id` -- calls `sessions.close(ref)` directly.

## What has to be settled

Whether refusing service is actually wanted here, and at what granularity.
The honest answer may be a `503` from `handle()` on every `/api/` route once `#shuttingDown` is set, which would make questions of the OW-jimasu shape moot rather than merely guarded.
It may equally be that a shutting-down server answering `GET /api/sessions` from disk is harmless and only the event stream matters, in which case the guard belongs in `addClient` or `openEventStream` alone.
Weigh it against what the browser does with a `503` on each of those routes: a reconnect loop that is told `503` behaves differently from one whose socket simply goes away, and the client's handling lives in `src/client/`.

## Done when

Either `handle()` (or whichever narrower site the reasoning lands on) refuses during shutdown, with a test in `src/server/http/app.test.ts` that drives a request into an app whose `close()` is in flight and asserts the refusal, going red first -- or this card closes `--declined` with the reasoning recorded, naming which routes were judged harmless mid-shutdown and why the reconnecting event-stream client is acceptable.
