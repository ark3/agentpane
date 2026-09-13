---
labels: [unverified]
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
