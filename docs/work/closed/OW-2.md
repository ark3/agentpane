---
kind: deferral
where: 'client SSE adapter'
---

# Every native `error` callback is reported as a disconnect, and no reconnect/backoff policy exists anywhere — the browser's own `EventSource` retry is the whole story.

Fine on loopback; nothing owns it if that stops being true.

**Closed on 2026-08-19: answered by D8, and the premise was wrong in two
places.** Both halves checked at the source.

"Fine on loopback" understates it. Loopback is not a circumstance this happens
to enjoy, it is **D8** -- `src/server/index.ts:40` binds `127.0.0.1`
explicitly, and D8's own text says no auth token, cookie or localhost-bypass
layer needs to exist once remote access is off the table. It has since been
reinforced rather than relaxed: every `/api` request carrying a non-loopback
`Origin` is rejected, because closing the network is not closing the browser.
So "nothing owns it if that stops being true" describes a day that reopens D8,
CSRF handling and the auth question together, on which SSE backoff would not
be the interesting part.

"No reconnect/backoff policy exists anywhere" is not accurate either. The
server writes `retry: 500` as the first thing on every stream
(`broadcaster.ts:74`), overriding the browser's multi-second default so a
reconnect is fast, with the reason recorded beside it. Around that sit a
heartbeat and a `Bun.serve` `idleTimeout: 60` tuned to stay outside it
(`index.ts:41-43`), and recovery on reconnect is `sendOpeningSnapshots`.

Accurate: `api.ts:174` does map every native `onerror` to `onDisconnect`. It is
not swallowed -- the controller publishes `connection: "connecting" |
"connected" | "reconnecting"` (`controller.ts:22`, `:332`) and `App.svelte:204`
renders it.

The one genuinely open sliver, recorded rather than carried as an item: the
retry interval is fixed with no ceiling, so a permanently dead server is
polled twice a second forever. On loopback that is a refused connect to a
closed port, and the only thing it costs is telling "reconnecting" apart from
"the server is gone" -- a UI question, not a transport one. File it if that
distinction ever matters.
