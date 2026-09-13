---
labels: [defect]
blocked-by: [OW-risuwo]
closed: done
---

# A fork aliases the parent onto the fork, but the alias means "this conversation changed id" and a fork means "a second conversation exists"

Filed 2026-09-13 with OW-risuwo, which characterizes the behaviour this changes.
Do not start here: if OW-risuwo finds the alias inert in practice, this card shrinks to a documentation fix and should be re-read before any code is written.

## One mechanism, two meanings

`src/server/http/session-manager.ts` `#adoptRef` is reached from two places that mean different things, and it cannot tell them apart.

Its docblock describes the case it was built for: Pi's id "changes when `start()` resolves and when the first `submit()` resolves, because Pi's session id IS its JSONL path (D9) and a `virtual` session has no path until its first prompt writes one".
That is a **rename** -- one conversation, new id -- and everything `#adoptRef` does is right for it.
Aliasing the old key is right, re-keying `#pendingRequests` is right, and `list()` suppressing the superseded id is right.

`fork` calls the same function.
A fork is not a rename: the parent is a second conversation that still exists on disk with its own history, and the user can reasonably want to open it, prompt it, or close it.
Aliasing it says the opposite.

## What that costs, pending OW-risuwo's measurement

The parent's ref resolving to the fork's container makes `DELETE` on the parent dispose the fork -- on Pi and Claude, the agent the user is talking to.
And `list()`'s alias filter drops the parent from the listing, on the reasoning that a superseded id "is not a session of its own", which is exactly the claim that is false for a fork.

Both are read, not run.
OW-risuwo settles them and its close note is this card's premise.

## The shape of the fix

The distinction is the deliverable: a ref change caused by a fork does not alias, and a ref change caused by a rename does.
`fork` knows which it is; `#adoptRef` does not, and that is the seam.

What the parent becomes on each backend, once it is not aliased:

- **Pi** -- the live process genuinely moved to the fork, so the parent is a **detached** on-disk session.
  That is a state D9 and D12 already define, and the next attach rehydrates it through Pi's resume path.
  Nothing new is needed for it beyond ceasing to hide it.
- **Claude** -- today the parent's process is killed outright; OW-razoki changes that separately, and this card should not wait on it or assume it.
  Until it lands, the parent is detached in the same sense as Pi's.
- **Codex** -- unaffected: `adapter.ref` never changes, so `#adoptRef` early-returns and no alias is written today.

Do not solve this by teaching `list()` to recognize forks.
The alias is what is wrong; a filter that compensates for a wrong alias leaves `#lookup` still resolving the parent onto the fork, which is the half that can kill a running agent.

## Done when

The tests OW-risuwo wrote for the two consequences flip: `#lookup` on a forked parent's ref no longer returns the fork's session, `list()` includes the parent, and `DELETE` on the parent's ref does not dispose the fork.
Each goes red first against today's behaviour.

The rename path keeps its tests green -- a `virtual` Pi session renaming on first prompt still aliases, still suppresses the old id in `list()`, and still re-keys `#pendingRequests`.
That suite is the guard against fixing fork by breaking rename, and if no such test exists, write it before touching `#adoptRef`.

`#adoptRef`'s docblock states both cases and which one aliases, since its present wording describes only the rename and is what made the two look interchangeable.
The passing assertion in `src/client/controller.ts` `forkAndSubmit`'s orphan comment -- that the parent's ref resolves to the fork's live process -- is retired in the same change if OW-risuwo confirmed it, since a correction left only in the server module reaches nobody reading the client.

## Close note

Done. `#adoptRef` in `src/server/http/session-manager.ts` now takes a `cause: "rename" | "fork"` from its caller, which is the seam the card named: `attach` and `submit` pass `"rename"`, `fork` passes `"fork"`, and only a rename writes the two alias entries. Everything else on the fork path is unchanged and deliberately so -- the container genuinely moves, so `#sessions` and `#pendingRequests` are still re-keyed.

Commits 0edd97e (the change) and bdd566d (two stale copies the review found). `bun run check` green, 1044 tests.

**The three consequences flipped, and each was watched go red first.** Independently re-flipped by the dispatching session by ungating the guard: four failures, with the rename suite `describe("an adapter that renames itself (the Pi contract)")` staying green throughout, which is what the card asked for as the guard against fixing fork by breaking rename. That suite already covered all three of its guards, so nothing was added to it.

- `"leaves the parent detached rather than aliased onto the fork"` -- `adapterFor(parent)` is undefined, `canonicalRef(parent)` hands the ref back, `summaryOf(parent)` is null.
- `"keeps the parent in list() after a ref-changing fork"`.
- `"leaves the fork's live adapter alone when the parent's ref is closed"` -- `close()` already returns silently for a ref it cannot find, confirmed rather than assumed, so a `DELETE` on a detached parent is a no-op and the route still answers 204. Nothing was added to make that so.

The retarget loop needed the same gating and got its own test, `"leaves an older alias of the parent pointing at the parent"`: a `virtual:` id that materialised into the parent is an older name for the *parent's* conversation, so following the container onto the fork would recreate the bug one level up -- a stale client handle that can kill the live fork. Mutation-tested during review: gating only the loop fails exactly that one test.

**Copies of the overturned fact retired in the same change**, per the every-copy rule: `#adoptRef`'s docblock (now states both causes), `SessionManager.fork`'s docblock, `list()`'s "an id we have superseded" comment, the `fork()` bullet in `src/server/adapters/claude/adapter.ts`'s header (which had said the parent "does NOT turn up in listings"), and the passing assertion in `src/client/controller.ts` `forkAndSubmit`'s orphan comment that the parent's ref resolves to the fork's live process. Review found two more the implementer missed: `list()`'s rewritten comment claimed "only a rename writes an alias" when `#start` writes three for spelling canonicalisation, and `docs/WORKSTREAMS.md`'s client contract still promised the old id "keeps working on REST routes indefinitely" and that "no *event* will ever carry it again" -- neither survives a fork. Both fixed in bdd566d. `src/server/http/app.ts`'s fork-route comment already said "the parent survives detached" and is true for the first time.

**Three findings filed rather than folded in.** OW-suhoto is the client half and the one to read next: `#adoptRef` still broadcasts `renamed` on the fork path, to every browser, and `session-state.ts`'s `renamed` arm deletes the parent's `SessionView` and moves the selection onto the fork -- so a second tab reading the parent is yanked onto a conversation it never opened. Not a regression (before this change the server agreed with that event) but now the one place the old model survives; the card records that dropping it for `cause === "fork"` was checked and is load-bearing for nothing. OW-yavewa is a pre-existing race: a `close()` concurrent with a `fork` or `submit` lets `#adoptRef`'s `finally` put the disposed adapter back into `#sessions`. OW-sehaja is the fork's summary carrying the parent's stored preview, harmless while the parent was hidden and visible now that both rows list -- related to OW-vezipo.

OW-vezipo needed no further amendment: OW-risuwo's close note already recorded that fixing the drop makes its twin-rows symptom bite on all three backends, which is what happened.
