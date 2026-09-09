---
labels: [deferral]
---

# SSE writes have no backpressure, so a stalled tab accumulates whole-transcript snapshots in server memory without bound

`src/server/http/app.ts`, the SSE stream: each event is `controller.enqueue(...)` without consulting `desiredSize`.
`src/server/http/broadcaster.ts` fans out synchronously to every subscriber.
Every re-attach and every rename emits a full snapshot, and D3 accepts that on loopback, so a tab the browser has throttled or a client that stopped reading holds an unbounded queue of them in this process.
Loopback makes it unlikely and does not make it impossible; the heartbeat in `src/server/index.ts` detects a dead stream, not a slow one.

Deferred because nothing has been observed, and the fix is a policy the owner has to choose: drop a subscriber whose `desiredSize` goes negative for longer than the heartbeat and let `EventSource` reconnect into a fresh snapshot, which D2 already makes free, or coalesce snapshots per subscriber so at most one is pending.
OW-luzipe is the adjacent open deferral on what a single turn sends.

## Done when

A test in `app.test.ts` or `broadcaster.test.ts` holds a subscriber's reader closed while several snapshots broadcast and asserts the chosen bound holds; it fails before the change.
