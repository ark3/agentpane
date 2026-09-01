---
labels: [defect]
---

# The composer's optimistic requesting mark is indistinguishable from wire truth, so narrow races can wipe or flicker it.

Found by the adversarial review of OW-natiha's implementation (landed in e0bbc16 and 09b3132) and accepted there as known limitations; this card is the record and the unit of any fix.
`src/client/controller.ts` (`compact()`, the block commented "The session reads \"requesting\" from the click itself") and `src/client/session-state.ts` (`setSessionCompaction` and the `status`/`snapshot` arms of `reduceServerEvent`) are the starting points.
The mechanism behind both defects is the same: the client writes `compaction: "requesting"` into the same per-session field the server feeds, so nothing downstream can tell the optimistic mark from wire truth.

## The two races

A `status` or recovery `snapshot` event carrying `compaction: null` that arrives between the click and the server's own `requesting` overwrites the optimistic mark: the acknowledgment vanishes, Send and Compact re-enable, and during a streaming turn — whose status ticks are frequent — Stop flickers back until the server's `requesting` or `running` lands.
Separately, in a multi-client session, a wire-truth `requesting` broadcast from another client's compaction can be standing when this client's own POST rejects; the failure path's `current === "requesting"` guard then clears a live mark, and the truth heals only when the server's `running` arrives.
Both self-heal within one server round trip on loopback, which is why OW-natiha landed without fixing them; the cost is a transiently lying composer, not stuck state.

## If a fix is taken up

Any fix likely tags the optimistic mark distinctly from server-fed state — for example a client-only field or phase value that server events do not write — rather than teaching the guard more cases.
Weigh that mechanism against the cost of the lie it removes before building it: the owner may decline this card, and the reasoning above is what the tradeoff turns on.

## Done when

A controller or session-state test reproduces each race — a `compaction: null` status wiping a fresh optimistic mark, and a rejection clearing a server-fed `requesting` — and each is watched red against the landed behavior before any fix, or the card is closed `--declined` with the tradeoff recorded.
