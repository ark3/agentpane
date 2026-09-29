---
labels: [defect]
---

# An attach that joins a virtual session's failed start during its reaping gives the virtual container back the name the failure took, so the stored session under that name is hidden and resolves to the virtual one

Found 2026-09-29 by the adversarial read of OW-kamave, by probe on both `main` at 0881d8c and OW-kamave's branch; it predates OW-kamave.
In service of the rule in the failure path of `#start` in `src/server/http/session-manager.ts`: a container that outlives a failed start "must not keep an id its adapter announced and never stored, or a retry would resume it" (the comment beside `refBeforeStart` and `namesBeforeStart`).

## The sequence

1. `createVirtual` gives V; `attach(V)` starts, and the adapter renames itself to R inside `start()` (`onRefChanged` → `#rename`), and then `start()` fails.
2. The failure path takes R back off V's container (the loop over `namesBeforeStart`), restores `bound.ref`, and the startup reaps its adapter, still answering to R until `#retire` (OW-yufazo, OW-kamave).
3. `attach(R)` arrives during the reaping and joins that startup: `attach`'s join calls `this.#hold(inFlight, requested)`, and `#hold` calls `#addName(pending.session, key)`, which puts R back into V's names and, since V is still in the table, into `#names`.
4. Afterwards `summaryOf(R)` answers the virtual container, and `list()` hides the stored session R behind it (`#ownSummary`'s dedup), although R is in the index.

The load-bearing part is step 3: a hold on a startup whose start has already failed must not give its container a name.
OW-kamave also made `#start`'s arbitration hand an attach over to a startup that claimed a container and is still reaping (a second route onto the same failing startup), and was asked not to widen this defect there. Check that route too.

## Done when

A test in `src/server/http/session-manager.test.ts` drives steps 1 to 3 with the dispose held (the OW-yufazo tests under "a rename announced inside start()" have the fakes: `renamingInsideStart`, `holdDispose`), and asserts, after the reaping, that `summaryOf(R)` does not answer the virtual container and that `list()` carries R's stored row. It goes red first and green after.
The rule it rests on is written once, where a hold decides whether to name the container. It must not be a check at each caller.
