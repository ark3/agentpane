---
labels: [defect]
blocked-by: [OW-risuwo]
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
