---
labels: [defect, sweep-0929]
closed: done
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

One function retires a startup from every record that says it is live — `#attaching`, `container.starting`, and the `#pendingForks` handle entry a handle-carrying fork starts from — at the one moment it stops being live, whether that is publish, failure or teardown.
`attach`'s `finally` delete and the scattered `bound.starting = undefined` clears in `#start` go; the join in `attach` then never sees a torn-down startup because teardown has already retired it.
`close()` does all of its synchronous work (table removal, `torndown`, retirement, removing the parked entry) before its first await, and folds the parked fork's disposal into the one disposal it registers in `#disposing` — including in the branch with no container, which today registers nothing.
D25 decision 1 in `docs/DESIGN.md` names OW-vodinu as one of its known exceptions ("The exception is a close that first disposes parked-fork adapters"); that sentence goes in the same change.

The deeper version — create the container before the index lookup and retire `#attaching` altogether — is not taken; the cold read below shows it breaks the canonical-name arbitration.

## What the cold read found (2026-09-29, at f89ab89)

A reader answered this card's two questions from the code after OW-letevu, which touched only request cleanup; the card's three claims all still hold.
What it added:

- **A fourth record: `#pendingForks`.**
  For a Codex fork carrying its parent's handle, `#start` takes `adapter = forkStart?.adapter ?? factory.create(...)`, and the parked entry stays until publish (`this.#pendingForks.delete(sessionKey(ref))` after `bound.starting = undefined`) or failure.
  For all of `start()` one adapter is reachable as both `pending.adapter` and the parked entry's `adapter`, so `close(F)` during F's in-flight attach disposes it once from the parked loop and again through `#terminate`, bypassing `#terminate`'s first-caller-owns-it memo, and `disposeAll()` does the same through `starting` and `parkedForks`.
  The retirement takes the handle entry at the claim, not at publish.
- **The no-container branch of `close()` must register a disposal.**
  A parked fork nobody attached has no container: `close(F)` deletes the entry and awaits the dispose, and an attach arriving meanwhile finds no parked entry, goes to the index lookup, and spawns a factory adapter on F's thread while the parked one is still being disposed — overlap `#disposing` exists to prevent.
  So the fold only works if that branch registers a `PendingDisposal` under the requested key.
- **OW-vodinu is two sequences, not one.**
  Case B, attach(F) already in flight when close begins: publish lands during close's parked await (`torndown` still false), attach resolves, then close disposes `session.adapter` a second time; `isAttached` is already false at the end at HEAD, so only the attach's resolution and the dispose count discriminate.
  Case A, attach(F) arriving after close began: the overlap in the previous item.
- **The loser of the arbitration needs retiring too.**
  `#start`'s two early returns onto a canonical container (`if (canonicalSession?.adapter)` and the wait on `canonicalSession.starting.promise`) leave the loser's `#attaching` entry until the `finally`; the retirement runs there as well.
  `#attaching` is keyed by the spelling the attach asked for, so `PendingStart` must carry that key for the retirement to find it.
- **Stays clear of the arbitration.**
  The loser awaits the winner's promise, not its record, so retiring at publish or failure does not affect it, and a teardown's `#disposing` entries under every name plus the canonical-disposal loop still gate a fresh spelling.
  Do not claim to change this existing behaviour: `close(B)` while B's startup waits on a winner cancels only B, because B is not yet a name on the winner.
- **Why the deeper version breaks it.**
  `attach(A)` pre-creates X{A}, `attach(B)` pre-creates Y{B}, both look up canonical C; X takes C, Y waits on X's startup and then `#addName(X, B)` moves `#names[B]` to X — but Y is still in `#sessions`, so `list()` shows a second row for the conversation (what `#ownSummary`'s dedup exists to prevent) and `close(B)` never removes Y.
  It would also bind waiters to startups that have validated nothing (a `close(C)` of a pre-created Z would reject X's attach though nobody closed A), needs a `cwd` nobody knows before the lookup, and inverts the "No await separates the arbitration above from this claim" invariant.
- **Teardown ordering for a fresh attach is already sound.**
  With a container the fresh attach waits on `#disposing`; with none, no adapter exists and each await in `#start` is followed by a `torndown` check, with nothing yielding between the last one and the claim.

## Done when

Tests in `src/server/http/session-manager.test.ts`, each shown red at HEAD first, that pass after:
- `close()` of a stored session still in its index lookup, then an immediate attach, starts afresh and answers rather than rejecting `UnknownSessionError`.
  Reachable without `holdStart`: a `SessionIndex` whose `get` awaits a `deferred()`, as in "does not spawn at all when teardown beats the adapter into existence", plus `settle()`.
- Case B: with a shared-handle fork's attach in flight (`FakeAdapterFactory({ forkMode: "shared", sharedChild, forkOptions: { holdStart } })`, as in "survives the parent being closed while the fork's attach is in flight"), `close(F)` rejects the attach, leaves `isAttached` false, and the fork adapter's `disposals` is 1.
- Case A: with a parked shared-handle fork nobody attached and its `dispose` held open (wrap `codex.created[0].fork` and swap `dispose` on the returned adapter, as the existing `adapter.dispose = async () => {...}` tests do), an attach issued after `close(F)` began creates no adapter while the dispose is held.
- `disposeAll()` inside the window between publish and attach's `finally` disposes the adapter once, asserting `disposals` — hooked deterministically by a broadcaster client that calls `disposeAll()` on the first `"sessions-changed"` frame, which `attach` emits inside that window.
- `disposeAll()` during a shared fork's `holdStart` disposes the fork adapter once.
The mechanism replaced is gone: `#attaching` and `container.starting` are cleared only in the one retirement function, and `attach`'s `finally` no longer deletes from `#attaching`.
Then OW-14, OW-ganapi, OW-vodinu and OW-13 close `--moot` citing this card, and the D25 exception sentence is gone.
OW-33 and OW-34 both evict through `close()`; note on each that this landed.

## Close note

Landed 2026-09-29 on `main` in two commits: "server: retire a startup from every record at the one moment it stops being live (OW-bulanu)" and "server: have disposeAll() wait on every close still disposing (OW-bulanu)".

What was built, in `src/server/http/session-manager.ts`:
- `#retire(pending)` is the only place a startup leaves `#attaching` and `ManagedSession.starting`; `PendingStart` carries the `key` its attach used and the `session` it starts. It runs at publish, on the arbitration loser's two early returns, at failure (a `.catch` on the startup promise, after the failure path has reaped its adapter, so an attach during reaping joins the failure rather than spawning beside it), and at teardown in `close()` and `disposeAll()`. `attach`'s `finally` delete and both `bound.starting = undefined` sites are gone.
- A parked fork handle leaves `#pendingForks` at the claim where it becomes `pending.adapter`; a recipe still stays parked through a failed start.
- `close()` does all synchronous work before its first await and registers one `#disposing` entry that also disposes parked handles, including when there is no container (keyed by the requested spelling). With no container and nothing to dispose it registers nothing, so a second DELETE cannot overwrite the first close's disposal; a test pins that.
- `disposeAll()` also waits on every in-flight `#disposing` entry. This fixed a regression the first commit introduced, found by the adversarial read: a startup that `close()` had retired was no longer reached by shutdown, which could `process.exit` during its SIGTERM-to-SIGKILL escalation. The same gap already existed on the old `main` for a published session mid-close, and the fix closes it too.
- The canonical-name arbitration is untouched. The deeper version, creating the container before the index lookup, was rejected by the cold read: it leaves the loser's container in `#sessions` (a duplicate `list()` row that `close(B)` never removes) and inverts the "No await separates the arbitration above from this claim" invariant.

How it was verified: ten new tests in `src/server/http/session-manager.test.ts`. The card's five, plus the published-session shutdown wait and the holdStart close-then-reattach case, were each red against the previous `main`'s source. The retired-startup shutdown wait was red on the intermediate commit. The second-close and recipe-stays-parked tests were shown red by breaking the guard and the claim condition respectively. `bun run check` passed: 1499 tests, svelte-check clean.
Docs: D25 decision 1's OW-vodinu exception sentence is removed, and the `docs/DESIGN.md` paragraph on `#attaching` now says what `disposeAll()` waits on.
OW-14, OW-ganapi, OW-vodinu and OW-13 closed moot citing this card, and OW-33 and OW-34 carry a note that it landed.
Filed OW-yufazo for a pre-existing miss the adversarial read found: a `close()` under a different spelling from its attach's key misses a startup still in its index lookup.
