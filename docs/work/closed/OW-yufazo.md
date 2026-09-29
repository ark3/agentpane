---
labels: [defect]
closed: done
---

# A close() under a different spelling from the one its attach was keyed by misses a startup still in its index lookup, so the startup publishes after the DELETE succeeded

Found 2026-09-29 by OW-bulanu's adversarial read, by reading `src/server/http/session-manager.ts` at 799eff2; nothing was run.
It was already on `main` before OW-bulanu, which did not claim to fix it.
In service of the rule that a `close()` that returned leaves no startup under any of the session's names on its way to publishing.

## The mechanism

`attach` keys its `PendingStart` in `#attaching` by `sessionKey(effectiveRef)`, and `effectiveRef` becomes `disposing.ref` (the closed container's canonical ref) when the attach first waited on a `#disposing` entry.
`close(ref)` with no container finds its startup only by `this.#attaching.get(sessionKey(ref))`, the spelling it was called with.
So:
1. `attach(A)` arrives while a close of the container that had names A and C is disposing, waits, and is keyed under C; while its index lookup runs, `close(A)` finds no container and nothing under A, takes the early return (`if (!session && !pending?.adapter && parkedAdapters.length === 0) return;`), and the startup goes on to publish.
2. The same miss under an unseen alias: `attach(alias)` is keyed under the alias until the lookup canonicalises it, so a `close(C)` in that window finds nothing.
3. During a failed start's reaping, after `#start`'s failure path has run `#remove(bound)`, a close under the canonical name or a name a rename inside `start()` added finds neither container nor record; nothing leaks, since the failure path disposes its own adapter, but no `#disposing` entry holds back an attach under that name.

Case 1 matters most: the DELETE answered for a session that then comes back attached.
Case 2 may be judged acceptable, because a close under C cannot know about an alias nobody has resolved yet; decide that in this card and record the reason rather than silently fixing only case 1.

## Done when

A test in `src/server/http/session-manager.test.ts` goes red first and green after: close a session holding names A and C, with its dispose held (`holdDispose`), then `attach(A)` with the index `get` held (the held-`SessionIndex` pattern in "starts afresh for an attach that follows a close of a session still in its index lookup"), then `close(A)`, release both; the attach rejects, `isAttached(C)` is false and `liveRefs()` is empty.
`isAttached(A)` alone proves nothing: as of 799eff2 a startup that took `disposing.ref` builds its container under C and never adds A as a name, so A reads detached even when the bug reproduces (amended 2026-09-29 on checking the card against the source).
Case 2 either gets the same test under an alias or a recorded reason in this card's close note, and case 3 likewise.
The fix changes who owns the lookup, for instance by keying the startup under every spelling it is known by, rather than adding a second lookup at `close()`.

## Close note

Landed on main as three commits (`server: hold a startup under every spelling it is known by`, `server: hold an attach waiting out a close as a startup`, `server: keep a startup's hold off a name another startup holds`, all tagged OW-yufazo); `bun run check` green on main, 1511 tests.
A `PendingStart` now carries `keys`, every spelling it is held under in `#attaching` (`#hold`, retired together by `#retire`): the spelling each attach asked for as well as the one it resolved to, and the container takes each as a name, so the requested spelling also survives a clean attach that waited out a close.
An attach that finds a `#disposing` entry registers as a startup before it waits (`#afterDisposal` does the rest after), so a `close()` under the spelling it asked for stops it whether it is still waiting or in its index lookup; the card's literal step order and the lookup-ordered variant are both tests in `session-manager.test.ts`, red on the old code.
`close()` with no container registers its disposal under every key the startup held, and a failed start's reaping holds the startup under its container's names, restoring the container's ref, so an attach under the canonical or renamed name joins the failure rather than spawning beside the adapter being reaped.
Case 2 decided: an alias whose attach has already collapsed into another startup (`#handOver`) is covered and tested; a `close(C)` that lands while an unseen alias is still in its index lookup is left, because nothing can know the alias names C until the lookup answers, the startup then waits out C's disposal in `#start`'s canonical-disposal loop so no two adapters share a file, and the outcome is indistinguishable from an attach that arrived just after the close -- the existing test "rechecks canonical disposal after a refreshed metadata lookup crosses a second close" already expects it.
Case 3 fixed and tested ("holds back an attach under either name while a start that failed after the rename reaps its adapter", "resumes the stored session, not the id the failed start announced...").
The adversarial read found that the failure path's holds could displace another live startup from `#attaching` and orphan it, a regression against main; `#hold` now refuses to displace another live startup, which is a guard at the site, and OW-kamave carries the owner change that retires it along with three cases the two-record arrangement misses on main too.
