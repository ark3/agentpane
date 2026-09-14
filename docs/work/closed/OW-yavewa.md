---
labels: [defect]
closed: done
---

# A fork that resolves after a concurrent close puts the disposed adapter back into the session table

Filed 2026-09-13 from the adversarial read of OW-kekoji, which found this while tracing `#adoptRef`'s callers.
Pre-existing and untouched by that change; read, not run.

## The window

`SessionManager.fork` in `src/server/http/session-manager.ts` awaits `session.adapter.fork(entryId)` and then, in a `finally`, calls `#adoptRef(session, "fork")`.
`close()` running during that await deletes the parent's key from `#sessions`, clears its aliases and pending requests, unsubscribes it and disposes the adapter.
`#adoptRef` then runs regardless and executes `this.#sessions.set(newKey, session)`, putting a `ManagedSession` whose adapter is disposed back into the table under the fork's id -- and broadcasts `sessionsChanged` and `renamed` for it.

`submit`'s `finally` reaches `#adoptRef` the same way, so the window is not specific to fork.

`#adoptRef` has no teardown check of its own.
The guard that exists is in `#start`, which tests `pending.torndown` before calling it; nothing protects the `submit` and `fork` call sites.
`#disposing` does not help: `close()` populates it from `disposalKeys` computed before the re-key, so the fork's new key is not in it.

## What it leaves behind

A live-looking entry in `#sessions` for a session the user closed, backed by an adapter that is disposed.
`liveRefs()` reports it, so a reconnecting browser is handed a snapshot source for it, and `isAttached` answers true.
`attach` on that ref finds the table entry and hands back the dead adapter rather than spawning a replacement.

## Where to start

The reachability is the first question and it is not settled: a `close` concurrent with a `fork` or a `submit` needs a user acting on two handles at once, or the D12 reaper (which inherits `close`'s path) firing mid-turn.
Settle that before deciding the shape -- a check in `#adoptRef` that nothing can trigger is worse than the race, per AGENTS.md.

If it is reachable, the fix is a teardown flag on `ManagedSession` that `close()` sets before its first await and `#adoptRef` reads, mirroring `PendingStart.torndown`.

## Done when

A test in `src/server/http/session-manager.test.ts` drives `close()` concurrently with a `fork()` whose adapter resolves after it -- `FakeAdapterFactory` in that directory already gates dispose, and the existing test `"waits for a closing adapter to be disposed before attaching its replacement"` is the pattern for holding one open -- and asserts `liveRefs()` is empty afterwards.
It goes red first.

Or, if the race turns out to be unreachable, this card closes `--declined` with the reasoning recorded, which is the outcome that stops the next reader re-filing it.

## Close note

Reachable, and fixed in 1f29763 (`fix: a close mid-fork no longer re-keys the dead session back in`).

Reachability, settled by reading and confirmed against the source: nothing serializes the routes.
DELETE (`sessions.close`), fork (`sessions.attach` then `sessions.fork`) and prompt (`sessions.submit`) are plain concurrent handlers in `src/server/http/app.ts` under `Bun.serve`, and the manager's only guards are `#attaching` and `#disposing`, with which an in-flight `fork`/`submit` registers nothing.
Pi is the one backend whose `adapter.ref` actually moves, so the one that gets past `#adoptRef`'s `oldKey === newKey` early return: `src/server/adapters/pi/process.ts` `fork()` re-adopts the moved `sessionFile` unconditionally (copy-on-write), and `adoptSessionFile` moves it at a virtual session's first `submit()`.
Codex and Claude Code hit the early return.
There is no D12 reaper in the tree yet -- only the prose in `session-manager.ts` saying the future one inherits `close()`'s path -- so the reaching sequence today is two concurrent requests: prompt a Pi session once, `POST .../fork`, and `DELETE` the parent while Pi's fork + `get_state` + `hydrateMessages` round trips are parked.

The fix is the shape the card named: `torndown?: boolean` on `ManagedSession`, set by `close()` immediately before its first await, read by an early return at the top of `#adoptRef`.
The one check covers both call sites, since `submit`'s `"rename"` path and `fork`'s `"fork"` path reach it with no branch in between; no separate submit test was added for that reason.

Verified: `does not re-key a session that was closed while its fork was in flight` in `src/server/http/session-manager.test.ts` gates the fake adapter's `fork` (the pattern from `"waits for a closing adapter to be disposed before attaching its replacement"`), closes the parent while it is parked, then releases.
The fake's default `forkMode: "pi"` moves the ref, so the assertion is not vacuous.
Shown red first by hand with the guard line removed -- `liveRefs()` returned `[{backend: "pi", id: ".../a.jsonl#fork-e1"}]` against an expected `[]`, with `adapter.disposed === true` already asserted on the line above -- and green with it restored.
`bun run check` passes on `main`: 49 files, 1061 tests, svelte-check clean.

`disposeAll()` takes the other teardown path and sets no such flag, so the same `#adoptRef`-after-teardown window remains there; left alone deliberately and filed as OW-jimasu.
