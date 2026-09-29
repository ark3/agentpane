---
labels: [deferral]
---

# close()'s reach through names has two edges: a later close can replace an earlier one's #disposing entry, and the closure over a startup's keys can reach a startup of another container when a backend's rename disagrees with the index

Found 2026-09-29 by the adversarial read of OW-kamave, probed on both `main` at 0881d8c and OW-kamave's branch.
Deferred because the one sequence found for each is harmless or contrived, and both sit at the edges of the owner OW-kamave built (`#attaching` as the one index of startups, `close()` closing over `PendingStart.keys`), so they are one card and not two.
In service of `close()` in `src/server/http/session-manager.ts` stopping exactly the session it was asked for, and holding back an attach until everything it disposes has settled.

## 1. A later close replaces an earlier one's `#disposing` entry (predates OW-kamave)

Virtual V renames to R inside `start()` and fails with its dispose held; `close(R)` registers disposal d1 under {R, V} but leaves V's container in the table; `close(V)` then finds the container and registers a disposal that settles at once under V, replacing d1 there, so `close(V)` returns before the adapter is disposed.
Harmless in that sequence because V is virtual and absent from the index, so a later `attach(V)` fails anyway.
On both trees, an `attach(R)` afterwards resumes under d1's `ref` (V) and fails `UnknownSessionError` although R is in the index. That is the same `PendingDisposal.ref` choice OW-kamave's case-2 test was told not to pin.
The implementer of OW-kamave believed the replacement newly reachable without a container, through a flagged startup with an adapter sharing a name with an attach waiting out the earlier close; the reader could not construct it (inferred, not disproved).

## 2. The closure over keys reaches another container's startup (new with OW-kamave)

A = `attach(N)` is in its index lookup, where the index says N resolves to M; virtual V's start renames it to N, so V's startup W is held under N; A's lookup returns and builds container D with names {M, N}, and `#names` now points N at D; `close(V)` takes V out of the table without N, but W's keys hold N, so the closure flags A too, and `attach(N)` rejects `UnknownSessionError`.
It needs a backend's rename to disagree with the index about N, which no backend is known to do.
The comment in `close()` beside the closure says this. Look for "the closure over `PendingStart.keys`" or the start of its search.

## Done when

Each edge is either a test in `src/server/http/session-manager.test.ts` that goes red first and green after, or closed as not worth fixing with the reason recorded here. A fix for 2 must come from what owns a name (the table owns a name a container answers to), not from a skip at the closure site.
