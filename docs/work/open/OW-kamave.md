---
labels: [question, sweep-0929]
---

# Decide who owns a startup's identity while it is in flight, since three cards in a row have patched SessionManager's name-keyed records and each review found the next case

Found 2026-09-29 by the adversarial read of OW-yufazo's fix, by probe scripts run against both that fix and the `main` before it; every case below was reproduced on both, and none was introduced by OW-yufazo.
In service of the rule OW-yufazo served: a `close()` that returned leaves no startup under any of the session's names on its way to publishing.

## Reframed 2026-09-29, before anyone executed it

The owner reframed this card after reviewing OW-bulanu and OW-yufazo.
Its diagnosis below stands; what changed is the question it asks.

This is the third card in a row on one piece of state: OW-bulanu gave a startup one retirement point (`#retire`), OW-yufazo then added multi-key holds (`PendingStart.keys`, `#hold`), `#afterDisposal` and a no-displace guard in `#hold`, and its adversarial read filed this card with three more cases already on the `main` before it.
`src/server/http/session-manager.ts` grew from 1291 lines to 1429 across those two cards, and now answers "which startup is this name's" from five overlapping records: `#sessions`, `#names` with `ManagedSession.starting`, `#attaching`, `#disposing` and `#pendingForks`.
Each fix was correct and tested, and each left a guard at the site whose read named the next case; that is the pattern the `sweep-0929` stream exists to end, so this card must not be worked as the fourth patch.

The root is visible in the cases below: `#start` arbitrates on the container (`#lookup`, then `#handOver`) only after its index lookup, so until then a startup has no identity anyone else can find, only the spellings it was asked under.
So the question is not only which record owns name → startups, as the original "Done when" put it, but what a startup in flight *is* from the first attach to publish or failure, and which one owner answers for it — its names, its disposal, and a close under any of them.

OW-bulanu's cold read rejected one answer, creating the container before the index lookup, and the reasons are recorded in OW-bulanu's "What the cold read found": the loser's container left in `#sessions` as a duplicate `list()` row, waiters bound to startups that have validated nothing, a `cwd` nobody knows before the lookup, and the inversion of the "No await separates the arbitration above from this claim" invariant in `#start`.
Any design this card chooses answers each of those, whether or not it resembles that one.

## Before any implementer

Dispatch a cold-read reader first, asked to map every writer and reader of the five records above as the code stands, and to say which of them would remain under the owner it proposes.
Amend this card with its map before choosing.

## The cold read's map (2026-09-29, at 46f79fc)

A reader mapped the five records from the code and confirmed all three cases below by probe on `46f79fc`, adding two variants of case 1.

- `#sessions` and `#names` are the table: `#add`, `#remove` and `#addName` write them, and everything that goes through `#lookup` reads them.
  They answer "which container does this name reach", which is not a startup's question.
- `ManagedSession.starting` is written by `attach` (existing container), `#afterDisposal` and `#start`'s claim, cleared by `#retire`, and read by `attach`'s join, `#handOver`'s `const winner = container.starting`, and `close()`'s precedence line.
- `#attaching` is written only by `#hold`, from `attach`, `#handOver` (the winner takes the loser's keys) and the failure path's `for (const name of bound.names) this.#hold(pending, name)`; `#retire` is its only remover.
  It is read by `attach`'s join without a container, `#hold`'s no-displace guard, `close()`'s no-container branch and `disposeAll()`.
  `PendingStart.keys` is read by `#retire`, `#handOver`, `#afterDisposal`, the claim, and `close()`'s `disposalKeys` only when there is no container.
- `#disposing` is written by `close()` alone and read by `attach` (by the spelling asked for), `#start`'s canonical-disposal loop and `disposeAll()`.
- `#pendingForks` is written by `fork()`, deleted by `#start` (a handle at the claim, a recipe at publish), `close()` by `parkedKeys`, and `disposeAll()`.

The two variants, both reproduced on `46f79fc`:

- **1a.** As case 1, but P has already published when `close(C)` lands: `B.starting` is `undefined`, so the precedence line finds no startup at all, and Q publishes after the close returned.
- **1b.** Q = `attach(R)` is in its index lookup when a container's start renames it to R; `#addName` gives the container R while `#attaching[R]` still holds Q, and `close(R)` flags only the container's startup, so Q publishes after the close returned.
  Any name a container gains that a startup is still looking up does the same.

The reader proposed one startup per name, with a container that gains a held name superseding the startup holding it.
That was not chosen: once the superseding startup has published, a close of its container has no record through which to reach the superseded one, which is still in its lookup, and case 1a comes back one level down.
It also recommended landing a `close()`-only fix first; that is the fourth patch this card exists not to be, and it was declined.

## Chosen 2026-09-29

The owner of a startup in flight is `PendingStart`, and `PendingStart.keys` is the one record of the names it answers to, from its attach until `#retire`.
`#attaching` becomes the one index from a name to the startups under it, and holds more than one startup per name, because the collisions above are states the manager legitimately reaches; nothing refuses a hold.
A startup bound to a container in the table is held under every name of that container, gaining each at the moment the container does -- the claim, a rename, `#handOver`, `#afterDisposal` -- and keeping each until it is retired, including the names a failed start takes back off the container.
`close(name)` asks that index alone for startups: it flags every startup held under the name, under each name of the container the name reaches, and under each key of every startup it flags, and that one key set is what it discards parked forks under and registers its disposal under.
`ManagedSession.starting` remains only as the inverse of `PendingStart.session`, answering which startup builds a container (`attach`'s join with a container, `#handOver`); `close()` never reads it.
Arbitration is unchanged: a container is still built only at the claim, after the index lookup, and `#handOver` still decides between two startups for one file.
So of OW-bulanu's four objections, the duplicate row, the unknown `cwd` and the claim's no-await invariant do not arise, since nothing is created earlier; and no waiter is bound to a startup that validated nothing, since a close reaches a startup only through a spelling its attach asked for, a name a container got from the index or its adapter, or a key `#handOver` moved after a lookup.
Retired: `#hold`'s no-displace guard, `close()`'s precedence line, the failure path's hold loop, and the separate `parkedKeys` and `disposalKeys` constructions.
Kept: the table, `#disposing` (it outlives both container and startup, keyed by name because what it holds back arrives as a name), and `#pendingForks` (a parked fork has neither container nor startup).
"Does the manager hold this ref", for OW-royosa: a name in `#names`, a non-empty entry in `#attaching`, or an entry in `#pendingForks`; a close retires what it flags from `#attaching` at once, so a close still disposing does not count.
The change fits this card, so it is built here rather than filed.

## Done when (replaces the original below)

The decision is recorded in `docs/DESIGN.md`, as an amendment to D24 or a new decision, naming the one owner of a startup in flight, the records it retires, and how it answers OW-bulanu's four objections.
The three cases below, and variants 1a and 1b above, are tests in `src/server/http/session-manager.test.ts` that go red first and green after, with the assertions the original "Done when" names; the tests OW-bulanu and OW-yufazo added keep passing without edits to their assertions.
The `#hold` no-displace guard is gone, and so is every other guard the new owner makes redundant, each named in the close note.
If the change is too large for one card, this card closes on the decision and files the implementation cards, labelled `sweep-0929`.

## The ownership problem

In `src/server/http/session-manager.ts`, which startup answers for a name N is held in two places: `#names` → the container → `ManagedSession.starting`, and `#attaching`, a `Map<string, PendingStart>` holding one startup per spelling (`PendingStart.keys`, written through `#hold`).
`close()` asks exactly one of them, chosen by precedence: `session ? session.starting : this.#attaching.get(sessionKey(ref))`.
Two startups for the same session file can both be live, because `#start` arbitrates on the container (`#lookup(summary.ref)`, then `#handOver`) only after its index lookup, and a second startup already in its lookup under the canonical spelling is invisible to that arbitration.
OW-yufazo made `#hold` refuse to displace another live startup rather than change this, which is a guard at the site; this card replaces it.

## Cases the current arrangement misses

1. A close that finds a container ignores another startup held in `#attaching` under one of its names.
   The index resolves REF to C, and `index.get(C)` is held; `P = attach(REF)` and `Q = attach(C)` start in the same tick; Q is held under C mid-lookup; P's lookup finishes first and builds container B with names {C, REF}, and P's `start()` is held.
   `close(C)` finds B, tears down `B.starting` (P) and never looks at `#attaching[C]`; Q then waits out the disposal and publishes after `close(C)` returned.
2. A `virtual` container's failed-start reaping, closed under its container name.
   `createVirtual` gives V; `attach(V)` renames it to R inside `start()` and then fails, and the failure path holds the startup under {V, R}; with the dispose held, `close(V)` finds the container, and its disposal keys come from `#remove(session)` alone, dropping `pending.keys`; so an `attach(R)` spawns a second adapter while the first is still being reaped.
   It bites only when R resolves in the index, and D9 says nothing is stored before the first turn.
3. A parked fork recipe survives a close under the renamed name after a failed fork start.
   A fork is parked in `#pendingForks` under `forkRef`, its start renames it to T and fails, and `close(T)` lands during the reaping: `parkedKeys` in `close()` is `sessionKey(ref)` plus `session.names`, and with no container that misses `forkRef`, so a later `attach(forkRef)` forks the parent again, contradicting the `#pendingForks` docblock's "`close()` on that ref discards it".

## Done when (original, superseded by the reframed one above)

Each case above is a test in `src/server/http/session-manager.test.ts` that goes red first and green after, asserting that the close stops every startup under the name (the attach rejects, one adapter was created, `liveRefs()` is empty) or, for case 3, that `attach(forkRef)` after the close does not fork again.
The fix makes one record own name → startups, so that `close()` consults a single place that can hold more than one startup per name, and the `#hold` no-displace guard OW-yufazo added is gone.

## Amended 2026-09-29 under D26

OW-royosa, filed by OW-zavehi (D26 point 5 in `docs/DESIGN.md`), is blocked by this card because it needs one answer to "does the manager hold this ref" -- the table, parked forks and a startup in flight, and not a close still disposing -- and this card decides who owns the last of those.
Whichever way this card closes, say in the decision how that question is answered, and if it closes on the decision and files the cards that build the owner, add the one that builds it to OW-royosa's `blocked-by` in the same session, so OW-royosa does not come free before the owner exists.
