---
labels: [defect, sweep-0929]
---

# SessionManager retires a startup at three different moments by three writers, so close() and an attach racing it each see a startup that is neither live nor gone

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
It is meant to supersede four cards that each patch one gap between those moments:
- OW-14, a re-attach joining a torn-down startup and inheriting its 404;
- OW-ganapi, the same mechanism filed again from OW-suyinu's review (the two are duplicates);
- OW-vodinu, `close()` awaiting a parked fork's dispose before it marks anything;
- OW-13, `disposeAll()` reaching one adapter through both tables.

## The state with no single owner

Whether a startup is still the live one for its session, in `src/server/http/session-manager.ts`:
- `#start` clears `ManagedSession.starting` when it publishes the adapter and when it fails (the `bound.starting = undefined` sites);
- `attach` deletes its `#attaching` entry only in its `finally`, after awaiting the startup's promise;
- `close()` and `disposeAll()` only set `PendingStart.torndown`, removing neither record.
Adapters are disposed down three routes as well: `#terminate`, a direct `session.adapter?.dispose()` in `close()` and `disposeAll()`, and a parked fork's own `dispose()` out of `#pendingForks`.

## What the sweep found beyond the four cards

- The join in `attach` (`const inFlight = existing ? existing.starting : this.#attaching.get(key)`) never checks `torndown`.
- For a stored session still in its index lookup, `close()` finds no container, so it registers nothing in `#disposing` and returns at once; an `attach` right after joins the torn-down startup and 404s.
  So OW-ganapi's window is as long as the index lookup, not as long as a kill, and a test can reach it without `holdStart`.
- All three adapters memoise `dispose()` (`codex/adapter.ts`, `claude/adapter.ts` with its test in `adapter.test.ts`, `pi/process.ts`), so OW-13 and OW-vodinu's double dispose are harmless.
  What remains of OW-vodinu is its second cost: a 200 answered and `isAttached` true for a session being closed.

## The change

One function retires a startup from every index — `#attaching` and `container.starting` — at the one moment it stops being live, whether that is publish, failure or teardown.
`close()` does all of its synchronous work (table removal, `torndown`, removing the parked entry) before its first await, and folds the parked fork's disposal into the one disposal it registers in `#disposing`.
A deeper version would create the container before the index lookup and retire `#attaching` altogether; it collides with the canonical-name arbitration in `#start` (OW-fumegi), so do not take it without a cold read that answers that.

D25 decision 1 in `docs/DESIGN.md` names OW-vodinu as one of its known exceptions; that sentence goes in the same change.

## Done when

Tests in `src/server/http/session-manager.test.ts` that fail before the change and pass after:
- `close()` of a stored session still in its index lookup, then an immediate attach, starts afresh and answers 200 rather than 404;
- a start that publishes while `close()` has a parked fork to dispose leaves the session closed, the attach not answered 200, and `isAttached` false;
- `disposeAll()` inside the window between publish and attach's `finally` disposes the adapter once (assert on the adapter's dispose count, not on memoisation hiding a second call).
Then OW-14, OW-ganapi, OW-vodinu and OW-13 close `--moot` citing this card, and the D25 exception sentence is gone.
OW-33 and OW-34 both evict through `close()`; note on each that this landed.
