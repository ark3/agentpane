---
labels: [question]
---

# Should the SSE reconnect path re-list, so state missed while the connection was down heals on its own?

`src/client/controller.ts` -- `handlers.onOpen`, which today publishes `connection: "connected"` and nothing else, and `refreshSessions` a few hundred lines above it.

Raised by OW-lejahi and left open by it.
That card fixed one symptom of this: a Detach performed while the SSE was down killed the agent but left the sidebar's attached stripe lit, because the stripe reads `summary.status` and only a listing moves it.
The fix landed there is narrow and deliberate -- `detach()` now asks for its own `void refreshSessions(false)` rather than only riding the `sessions-changed` broadcast -- and OW-lejahi itself named the wider alternative as possibly the better answer.

The question this card holds is the general one.
Every other state change that happens while the connection is down still waits for the user to press Refresh; a detach is now self-healing and nothing else is.
Re-listing in `onOpen` would heal all of them at once and make the per-operation re-list OW-lejahi added redundant.

What makes it a question rather than a defect is that the costs are real and unmeasured.
`onOpen` fires on every reconnect, and a flapping connection would then list on every one; `refreshSessions` walks both backends' whole session stores, which D9 records as 973 files on the owner's machine.
`refreshSessions(false)` surfaces nothing, so a storm would be invisible rather than merely noisy, and `refreshInFlight` coalesces concurrent calls but not successive ones.
Reconnection also already delivers snapshots that carry per-session state, so what a listing adds is specifically the summary fields -- `status`, `cwd`, `updatedAt` -- and it is worth naming which of those actually go stale.

Load-bearing: the decision, not an implementation.
Incidental: whether OW-lejahi's call in `detach()` then comes back out -- that is a cleanup either way the decision goes.

Done when the decision is recorded where the next reader will look: in `docs/DESIGN.md` if it becomes a decision, or in the docblock at `handlers.onOpen` if the answer is no, saying why reconnection deliberately does not re-list.
If the answer is yes, this card also carries the change and closes on a controller test that reconnects with no broadcast and sees a freshened listing, red first.

## Measured 2026-09-16

The costs the card called unmeasured, measured by reading the code at `main` 4f38486.

**`onOpen` fires on the initial connect too, not only on reconnects.**
`src/client/api.ts` -- `defaultOpenEvents` -- wires the native `EventSource` and nothing else: `source.onopen = () => handlers.onOpen()`, `source.onerror = () => handlers.onDisconnect()`.
There is no custom reconnect layer, no first-connect flag, and `onerror` cannot distinguish a transient drop from a fatal close.
`docs/DESIGN.md` D2 says why: "`EventSource` reconnects natively; under D3 recovery is just 're-snapshot', so we write no backoff/retry state at all."
So a bare re-list in `onOpen` races `start()`'s own `refreshSessions(true)`: `refreshInFlight` is assigned synchronously, so an `open` landing while that first listing is in flight coalesces, but one landing after it resolves lists a second time.
Whether the real browser lands inside that window is not decidable from the code.
`e2e/harness.ts:258` and `e2e/perf-harness.ts:201` both fire `onOpen` in a `queueMicrotask`, i.e. always inside it, so the vehicle would never show the double listing.

**Reconnection heals transcripts only, and nothing about the session list.**
`src/server/http/app.ts` -- `openEventStream` -- calls `broadcaster.sendOpeningSnapshots(client, sessions.liveRefs())`, under the docblock "Attach and reconnect are the same thing (D3) ... There is no resume protocol and deliberately no Last-EventID handling."
`Last-Event-ID` appears nowhere in `src/`: no cursor, no replay buffer, no per-client backlog.
`liveRefs()` is `[...this.#sessions.values()].filter((s) => s.adapter)`, so only sessions with a live adapter get anything -- a detached session existing only on disk gets nothing.
The `snapshot` payload in `broadcaster.ts` is `{ session, seq, messages, isStreaming, compaction, model }`, and carries no `status`, no `updatedAt`, no `cwd`, no `preview`.
Every corpus change that happened while the socket was down was announced by a `sessionsChanged()` fanout -- createVirtual, attach, rename/adopt, each turn boundary, markPrompted, close -- which is pure fan-out with no replay, so those events are simply lost.

**Of the seven `SessionSummary` fields (`src/shared/protocol.ts`), reconnection heals one, and the two that go both wrong and visible are listing-only.**
`status` -- from `#liveOverlay` -- is carried by no event of any kind; it lights the sidebar's attached stripe (`class:session-attached`) and gates the header's `detachable`.
`updatedAt` is the file's mtime, re-read only on a listing, and it drives the whole sidebar ordering; `session-manager.ts` already says so at the turn-boundary broadcast -- "The session list sorts on `updatedAt`, which only a re-list carries, so without this the order never moves until someone presses Refresh (OW-furinu)."
`isStreaming` is the one field reconnection effectively heals, and only because the UI reads live-first: `view.state.sessions[key]?.isStreaming ?? summary.isStreaming`.
`cwd`, `preview` and `ref` go wrong only through creations, materialisations and renames missed while down; `cwd` then feeds the workspace picker, the client-side filter, the row's directory chip and the `cwd` a New session inherits.
`createdAt` is read nowhere in `App.svelte`.

**A listing is an uncached full-corpus walk, and its cost on this machine today is unmeasured.**
`src/server/sessions/index.ts`'s docblock is explicit -- "No cache -- fresh walk + read on every call" -- and there is no memoisation, mtime short-circuit or TTL on the path.
Per call it walks three roots and `mapLimit(files, 64, loadOne)` stats and opens every file found, reading from each head until a preview is satisfied, then sorts; `session-manager.list()` then layers the alias filter, the overlay and a second sort.
The 973-file figure everything cites is `docs/HANDOFF.md` row 19: walk ~0.01s, read first line of all 973 files ~0.27s, **in Python, on the work laptop, 2026-08-10** -- so it is not this TypeScript implementation, not the home server, it predates the Claude Code store joining the walk, and "read first line" is strictly less than what the shipped parsers read.
No benchmark in the repo covers `GET /api/sessions`; the perf tests under `vite.perf.config.ts` measure client-side sort and streaming cost only.

**A flap is bounded at roughly two opens a second, and nothing debounces a listing.**
`broadcaster.ts` `addClient` pushes `retry: 500` as the stream's first bytes -- "Reconnect fast: this is loopback and recovery is just a re-snapshot" -- with no backoff and no cap, and the client adds none.
So a server bouncing after each successful open yields on the order of 100-120 `onOpen` calls a minute.
`refreshSessions`'s only guard is `refreshInFlight`, which coalesces concurrent calls and not successive ones, so if a listing takes ~0.3s a substantial fraction of a 2/s storm is swallowed and the rest runs.
Against that, `src/server/index.ts` sets `heartbeatMs: 15_000` under `idleTimeout: 60`, so an idle stream is not reaped and does not flap on its own.

**Prior art cuts both ways, and the closest piece is one commit old.**
Heal-on-reconnect is the governing principle but only for transcripts: D3 -- "full snapshot on attach and on every reconnect" -- and the `ServerEvent` docblock, "recovery is to re-subscribe and take a fresh snapshot, which is free on loopback."
The argument that would license not re-listing is `docs/DESIGN.md` on fork points: "That set is an affordance and may be briefly stale; nothing is decided on it."
That shape does not fit here, because `status` gates the Detach control and `updatedAt` reorders the sidebar.

**The test is cheap and goes red first.**
`src/client/controller.test.ts`'s `FakeApi` captures the handlers in `connect` but exposes only `emit(event)`; `handlers.onOpen` is invoked nowhere in that file, so both the `onOpen` and `onDisconnect` arms of the controller are untested today.
Adding an `onOpen()` method to the fake is two lines, and the body has an exact precedent in the test "re-lists after a detach that no sessions-changed broadcast follows", which re-mocks `listSessions` after `start()` and asserts on `state.summaries` with no event emitted at all.
It goes red first because today's `onOpen` publishes only `{ connection: "connected" }`.
Assert on `state.summaries` rather than on `listSessions` call count -- the startup listing already satisfies a count -- and `settle()` past the microtask, since a re-list would be `void`-ed.
The fake's `deferred()` helper can hold the startup listing open to pin the double-list race deterministically, which is the companion test for whether `onOpen` should skip the first open.
