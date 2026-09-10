---
labels: [defect]
---

# A fork abandoned by a mid-flight click leaves the forked session orphaned on the backend

Surfaced by the implementer and the adversarial reader on OW-mifuki, 2026-09-10; confirmed by reading `src/client/controller.ts`, not reproduced against a running backend.

OW-mifuki made `forkAndSubmit` honour a selection made during its round trip: it now re-checks `disposed || intent !== selectionIntent` after every await and returns null when the user clicked elsewhere.
The guard immediately after `const forked = await api.fork(ref, { entryId: point.id });` fires with the fork already created.
Nothing attaches it, nothing deletes it, and the user never sees it until it turns up in the sidebar on the next listing.

The shape is pre-existing — a rejected `api.attach` left the same orphan — but before OW-mifuki that needed a failure, and now an ordinary click during the fork's attach reaches it.

Two other things go with it, from the same reading:

- The guard after `await api.abort(ref)` is worse in kind than an orphan.
  A click landing in that window kills the parent's running turn and then abandons the fork, so the user loses the turn and gets nothing back.
  The button says "Stop and fork", so they did ask for the stop — but not for the nothing.
- Two of the intent guards have no test.
  Re-checked 2026-09-10 after OW-kelede landed, by the dispatching session as well as by a reader: removing the guard after `api.abort` leaves all 469 client tests green, and so does removing the guard after `api.forkPoints`.
  The third limb of the original claim is now stale — `send()`'s guard, which OW-kelede rewrote to `if (view.sending) return;`, is killed by `App > keeps the first fork's follow and badge when send is pressed twice in edit mode (OW-kelede)` in `src/client/App.test.ts`.
  The guard after `api.attach` was not mutated and its coverage is unknown.

## Done when

The decision is recorded, whichever way it goes, and the guards that survive it are covered.

Decide what an abandoned fork should do — leave it (and say so where the guard is, so the next reader stops re-asking), delete it, or never create it by moving the fork call after the last window in which a click can arrive.
"Delete it" is the expensive answer and was priced on 2026-09-10 — see the pricing below, which corrects this card's original claim that no delete route exists.

Then, whichever was chosen:

- A test in `src/client/controller.test.ts` covers the `api.abort` window: it asserts what the abandoned-fork decision says should happen, and fails before the change.
- A test covers the `api.forkPoints` window the same way.

## Load-bearing

The choice is what to do about the orphan, not whether the guard should exist — the guard is what OW-mifuki was for, and reverting it re-opens the yanked-selection defect that card closed.

## Pricing, 2026-09-10

Read off the source by a dispatched reader; the claims marked *confirmed* were re-checked by the executing session against the code, and no live run was involved.
Where a fact rests on live backend behaviour it cites `docs/MANUAL_TESTING.md` rather than anything run here.

**There are four windows, not three.**
`forkAndSubmit` guards after `api.abort`, after `api.forkPoints`, after `api.fork` and after `api.attach`.
A click in the fourth abandons a fork that is created *and attached* — on Codex, spawned — with no prompt in it.

**"Never create it", read as a reordering, is ruled out by a fact.**
The fork must precede the attach and the prompt, and both are awaits, so no ordering reduces the abandon window to zero.
Only the `select: false` variant survives under that heading, and it is a different proposal — see below.

**What exists after `api.fork` returns, per backend.**
The three are not alike, and "leave it" means something different on each.

- *Codex* is the clean case: `thread/fork` mints a thread the adapter is not driving, `adapter.ref` is unchanged so nothing is re-keyed and no `renamed` fires, and the parent keeps its process and its identity.
  The rollout is on disk immediately (`docs/MANUAL_TESTING.md`, OW-pifowo: `forked_on_disk_before_turn: true`).
  The abandoned fork is a file and nothing else.
- *Pi* is copy-on-write done by the CLI: the RPC moves the process's active file F1 to F2 and the adapter adopts F2.
  The parent's file survives byte-identical (`docs/MANUAL_TESTING.md`, OW-pifowo/OW-22, work laptop 2026-08-19, pi 0.84.2), but the live process is now driving the fork, so the parent is un-processed.
  Whether F2 is on disk at the moment `fork` returns is explicitly unsettled (OW-gajesu).
- *Claude Code* respawns this adapter's own child onto the fork; parent file byte-identical (`docs/MANUAL_TESTING.md`, OW-mayuza).
  Whether the forked store file exists before any turn is not settled — every OW-mayuza run drove a turn — so an abandoned Claude fork may be a live child with nothing on disk: invisible in the sidebar and still consuming an agent.

**The parent goes alias-shadowed on the two renaming backends.** *Confirmed.*
`#adoptRef` in `src/server/http/session-manager.ts` deletes the old key, re-keys the session under the fork's, and sets `#aliases[oldKey] = newKey`; `#lookup` follows aliases.
So after a Pi or Claude fork, attaching the parent by its own ref resolves to the fork — clicking the parent row opens the fork.
That is true of every successful fork, not only abandoned ones, but abandonment is exactly the case where the user goes back to the parent.

**"Delete it" via the route that exists buys the alias and the process, never the row.** *Confirmed.*
`DELETE /api/sessions/:backend/:id` exists after all and routes to `sessions.close(ref)`, which touches nothing on disk: it drops the session from the table, deletes its aliases, unsubscribes, and disposes the adapter.
`listSessions` in `src/server/sessions/index.ts` is a pure disk walk with no cache, no consultation of the manager's table and no filter for empty or forked sessions, so the abandoned fork still appears on the very next listing.
Making the row disappear means a new route that unlinks the transcript, plus a new method on `AgentpaneApi` in `src/client/api.ts`, which today has no delete at all.
That is destroying data, and on Pi it is deleting the file the live process believes it is in — so a DELETE would have to precede any unlink.
What `close()` alone *would* fix is the alias shadowing above and the orphaned child process.

**"Leave it" does not look like junk.** *Confirmed.*
Every backend's fork carries the parent's history, and the sidebar preview is taken from the *first* user message in the file (`parsePiSession` in `src/server/sessions/pi.ts` and its siblings), so the orphan renders as a near-duplicate of the parent with the same preview text, sorted just above it by mtime.
There is no reaper: D12 is decided but unbuilt (`docs/DESIGN.md`, OW-33/34/35), and the only mention in the server is the aspirational comment in `session-manager.ts`.
So on Pi and Claude the abandoned fork's child process lives until the server exits, and the parent stays alias-shadowed for that whole time.

**The `select: false` variant, adversarially.**
Complete the fork, attach and prompt as normal, but decline the selection when the intent changed.
`send()` in `src/client/App.svelte` needs no change and is arguably improved — `landed` is truthy, so `disarmSubmit` does not fire and `rekeySession` moves the follow and badge arming onto the fork, which is exactly the mechanism for "a session streams while you look elsewhere".
Its costs:

- The bump `intent = ++selectionIntent` runs *before* the attach and would have to become conditional, with a flag captured at each guard site, because the bump itself destroys the information.
  Left unconditional it breaks the user's own click: their `attachAndSelect` takes the `else` branch, never sets `selected`, and — the `finally` being intent-gated too — leaves `busy: "attaching"` stuck at "Opening session…" forever.
- `applyAttached`'s `select` is not a pure "do not select": it still selects when the requested ref is already the selected one.
  The reader read that as a hole on the two renaming backends, because `reduceServerEvent`'s `renamed` branch in `src/client/session-state.ts` moves `selected` onto the fork with no intent guard anywhere near it.
  The executing session traced that and it is weaker than it looks: the reducer moves `selected` only while it is *still* the parent's ref, and the user's own click resolves onto the clicked session afterwards and wins.
  Clicking a session already attached in this client moves `selected` synchronously in `preview()`, so `sameRef` is false by the time the rename lands and nothing moves at all.
  What is left is a transient flicker of the transcript onto the fork while a *stored* session's preview is still fetching — worth knowing, not a blocker for this variant.
- It guarantees a spawn and a full turn in a session the user has navigated away from, with no reaper.
- `select: false` is `recover`'s path, and OW-yasewo's docblock says so in as many words; reusing it for a gesture means restating that reasoning.

**The `api.abort` window is separable and cheap.** *Confirmed.*
Reorder to `forkPoints` then guard then `abort` then `fork`, with no guard between the abort and the fork, making stop-and-fork atomic.
That eliminates the window outright and touches the orphan question not at all.
The caveat is that `listForkPoints` would then run against a streaming session; fork points are one per user message and the in-flight turn's user message is present either way, so the exposure looks cosmetic — but no captured fixture settles it, and the Pi half would need a live run on the work laptop.

## Not decided, 2026-09-10

The executing session priced this and did not choose.
The branch that removes the row destroys a transcript, the answer is backend-asymmetric, and this repo puts that class of call with the owner — D15's own docblock in `forkAndSubmit` records the owner taking the neighbouring one.
The card stays open on the decision; the two guard tests it asks for cannot be written until the decision says what they should assert.
