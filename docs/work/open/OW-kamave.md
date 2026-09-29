---
labels: [defect]
---

# Two records answer which startup a name belongs to -- a container's starting and #attaching -- so a close under a name that both hold stops only one startup and the other publishes after the DELETE

Found 2026-09-29 by the adversarial read of OW-yufazo's fix, by probe scripts run against both that fix and the `main` before it; every case below was reproduced on both, and none was introduced by OW-yufazo.
In service of the rule OW-yufazo served: a `close()` that returned leaves no startup under any of the session's names on its way to publishing.

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

## Done when

Each case above is a test in `src/server/http/session-manager.test.ts` that goes red first and green after, asserting that the close stops every startup under the name (the attach rejects, one adapter was created, `liveRefs()` is empty) or, for case 3, that `attach(forkRef)` after the close does not fork again.
The fix makes one record own name → startups, so that `close()` consults a single place that can hold more than one startup per name, and the `#hold` no-displace guard OW-yufazo added is gone.
