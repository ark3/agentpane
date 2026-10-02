---
labels: [deferral]
closed: declined
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

## Amended 2026-09-28 under D25

Under D25 the prompt, fork, fork-points, model and effort routes stop attaching first (OW-sirofi), so they no longer reach `attach`'s `#shuttingDown` check and join abort and compact among the routes that serve during shutdown.
The reconnecting client above still applies, since D25 keeps D21's listing at a reconnect.

## Close note

Declined, by OW-geselo on 2026-10-01: refusing service during shutdown buys nothing, because at b758f98 every route either refuses already or does nothing harmful.
`disposeAll()` in `src/server/http/session-manager.ts` sets `#shuttingDown` and clears `#sessions`, `#names` and `#pendingForks`, and retires every startup, all before its first await; `app.close()` calls `broadcaster.closeAll()` first, and `src/server/index.ts` then runs `server.stop(true)` and exits.
Per route, mid-shutdown:
- GET a session (attach): 503 `server_shutting_down` (app.test.ts "returns 503 when an attach arrives during shutdown").
- prompt, fork, model, effort: not attached, 409 `not_attached`; fork-points: no adapter, 409.
- abort and compact: `UnknownSessionError`, 404 `not_found` (not `not_attached`, as the sweep had it); refused either way.
- DELETE a session, DELETE an error: nothing to close or clear, 204.
- GET /api/sessions and preview: disk reads with an empty live overlay, everything reads as detached.
- POST /api/sessions: `createVirtual` adds a container with no adapter and spawns nothing.
- GET /api/models: no live adapter, and all three unstarted adapters reject without spawning (Codex `requireClient`, Pi `sendCommand`, Claude `requireProc`), the same answer as any time nothing is attached.
- POST /api/edit-draft: spawns `$EDITOR` on a temp file it removes, the operator's tool rather than an agent, and nothing about it is specific to shutdown; static assets are served as ever.
- GET /api/events: a reconnecting browser registers after `closeAll`, gets opening snapshots from `liveHandles()`, now empty, and is cut by `server.stop(true)`; under D25 decision 3 it then holds nothing live and treats the drop as it treats any restart, so being briefly served by a leaving server costs it nothing.
Nothing spawns an agent mid-shutdown: a verb already queued in `#serially` reaches a disposed adapter, which refuses to write to the agent (a queued Codex `setModel` with no effort chosen still answers 204, as the `#serially` docblock says, and touches no process).
Reopen if a route is added that spawns an agent or writes durable state without going through `attach` or a live adapter.
