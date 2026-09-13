---
labels: [unverified]
closed: done
---

# Nobody has run what a fork actually does to the parent in SessionManager, and the code and two cards disagree about it

Filed 2026-09-13 from a design discussion that could not proceed without this.
The fix it gates is a fork-architecture change; this card only establishes what happens today.

## The reading that prompted it

`src/server/http/session-manager.ts` `fork` looks up the *parent's* `ManagedSession`, calls `session.adapter.fork(entryId)` on that same adapter, and then calls `#adoptRef(session)` in a `finally`.
No new container is created there.
Whether two sessions exist afterwards depends entirely on whether `adapter.ref` changed:

- **Codex** does not change it — `codex/adapter.ts` `fork()` fires `thread/fork` and returns the new thread's ref without repointing `this.threadId` — so `#adoptRef` early-returns on `oldKey === newKey` and the parent's container is untouched.
  The client attaches the returned ref and gets a container of its own.
- **Claude and Pi** do change it, so `#adoptRef` re-keys the container off the parent's id onto the fork's, and writes `#aliases.set(oldKey, newKey)`.

`#lookup` consults `#aliases`, so on those two backends the parent's ref now resolves to the fork's container.

## The two consequences to check, and the card already contradicting one

**Does `DELETE` on the parent's ref dispose the fork?**
`#lookup` says it should: the parent's key resolves to the fork's `ManagedSession`, and disposal runs against that.
The comment over the orphan-abandonment block in `src/client/controller.ts` `forkAndSubmit` already asserts this in passing -- "the server's `DELETE` route disposes the *adapter*, never the file, and `SessionManager.fork` re-keys `#aliases` so the parent's ref now resolves to the fork's live process" -- but that sentence was written from the same reading, not from a run.

**Does the parent drop out of `list()`?**
`list()` skips any stored summary whose key is in `#aliases`: "An id we have superseded is not a session of its own.
Listing it alongside the session that outgrew it shows one conversation twice, and offers the browser a handle that opens a second agent on it."
That reasoning is sound for a rename and wrong for a fork, where the parent *is* a session of its own.

But **OW-vezipo (open) says both rows are listed** -- "A forked session's row in the list is a character-for-character copy of its parent's, so the two cannot be told apart" -- which cannot be true of a parent the filter removed.
Three ways that resolves and this card picks one: OW-vezipo was written from the Codex case where no alias is set, something clears the alias that this reading missed, or one of the two is stale.
Whichever it is, say so in the close note and amend OW-vezipo if it is the one that is wrong.

Also worth a look while the vehicle is up: `claude/adapter.ts`'s own docblock says the parent "turns up in listings as a detached session", which is the opposite of what `list()` appears to do.
Either the docblock or the filter is wrong.

## Done when

A test under `src/server/http/` drives a fork on a backend whose ref changes and asserts what the manager does with the parent: whether `#lookup` on the parent's ref returns the fork's session, whether `list()` includes the parent, and what `DELETE` on the parent's ref disposes.
It passes against today's behaviour -- this card characterizes, it does not fix.
Where behaviour is wrong, the test says so in its name and the fix belongs to the cards blocked on this one.

The close note states, for each of the two consequences, whether it is real, and resolves the OW-vezipo contradiction explicitly rather than leaving both claims standing.

No live backend needed: the existing fakes under `src/server/http/` drive adapters whose `fork()` changes the ref.

## Close note

Ran it. Four tests in `src/server/http/session-manager.test.ts`, in the existing `describe("fork (the third #adoptRef point)")` block, characterize today's behaviour on the `FakeAdapterFactory`'s default Pi shape (ref changes) with a Codex-shape contrast. `bun run check` green; every assertion was flipped and watched go red, and three were re-flipped independently by the reviewing session.

The reading in this card was correct on all counts. `SessionManager.fork` makes no new container: it re-keys the parent's own `ManagedSession` onto the fork's id and leaves the parent's id behind as an alias.

**Does `DELETE` on the parent's ref dispose the fork? Yes, real.** The DELETE route (`app.ts`) calls `sessions.close(ref)`; routed through the alias it disposes the single adapter, which is now driving the fork. Test: "(WRONG) disposes the fork's live adapter when the parent's ref is closed". The comment in `src/client/controller.ts` `forkAndSubmit` that asserted this from a reading was right.

**Does the parent drop out of `list()`? Yes, real.** The index still reports the parent's stored summary -- on Claude its store file is untouched -- but `list()` skips any stored summary whose key is in `#aliases`, so the client sees only the fork. Test: "(WRONG) drops the parent from list() after a ref-changing fork". Also confirmed the third consequence the card did not name: `adapterFor`, `canonicalRef` and `summaryOf` on the parent's ref all answer about the fork, so after a Pi or Claude fork the parent is unreachable through the HTTP API entirely until a restart clears `#aliases`. That is OW-kekoji's subject.

**The OW-vezipo contradiction resolves as "neither is wrong, they are about different backends."** Not one of the three the card guessed, though closest to the first. Codex's `thread/fork` leaves `adapter.ref` unchanged, so no alias is set and both parent and fork list -- OW-vezipo's twin rows are real there today. Pi and Claude re-key, so the parent is filtered and there is one row, because one was hidden rather than because the two can be told apart. OW-vezipo amended in place with that scoping (it stays open, and fixing the drop makes it bite on all three backends).

**The Claude adapter docblock was the wrong one.** `src/server/adapters/claude/adapter.ts` said the parent "turns up in listings as a detached session"; it does not, per the test above. Corrected in the same change to state what the code does and why the alias filter is right for Pi and wrong for Claude.

Commits: cc5601b (the tests), da8589e (docblock correction plus the OW-vezipo amendment).
