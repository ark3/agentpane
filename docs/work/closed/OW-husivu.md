---
labels: [defect]
closed: declined
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

## Close note

Declined by the owner on 2026-09-11, twice: once on the card's own framing, and again after an adversarial read showed that framing understated the cost.
The reasoning is recorded in `ffde687` at `setSessionCompaction` (`src/client/session-state.ts`), at the `snapshot` early-return in `reduceServerEvent`, and at the failure-path guard in `compact()` (`src/client/controller.ts`).

## What the card got wrong, and what it cost to find out

The card said both races "self-heal within one server round trip on loopback".
Only the first does.
This client's POST is what makes the server write "requesting", so race one's healing event is already in flight when the mark is wiped.
Race two follows a **rejected** POST, which changes no server state, and `#onUpdate` (`src/server/http/session-manager.ts`) broadcasts only when streaming, model or compaction actually moves -- so nothing is coming.
The mark returns when the *other* client's compaction advances to "running", which is that session's progress, not a round trip.

The card also said the cost is "a transiently lying composer, not stuck state".
`compaction` is a gate, not a display field: `send()`'s `if (compaction) return;` and the two `disabled=` conditions in `src/client/App.svelte` all read it, and `src/client/controller.ts` has no compaction check of its own.
A wrongly cleared mark therefore re-opens Send and Compact while a compaction is genuinely running, the prompt goes out, and the backend refuses it with a visible error.

And the two halves of race two share one cause, which the card had as a coincidence.
Codex's `compact()` throws `TURN_ACTIVE_ERROR` when a turn is live; the other client's compaction *is* that live turn.
So the throw that reaches the guard is raised by the very mark the guard then clears.

## Why it was still declined

Both races need a second client driving the same session -- two tabs counts, not just two people.
The worst outcome is one refused prompt carrying an error, not damage and not stuck state.
Against that, the fix is a client-only phase value that every arm of `reduceServerEvent` has to be taught to leave alone, which is more machinery than the lie is worth.

The owner's words on the tradeoff: unlikely ever to see the problem this protects against.

## What would reopen it

A second optimistic mark anywhere in the composer.
The defect is a property of one client-written field sharing a slot with wire truth, so a second such mark brings the same two races with it, and at two the separate field starts paying for itself.
`sending` (`src/client/controller.ts`) is already a client-only field with its own rationale, so that shape is established rather than hypothetical.

## Not fixed here

No test was written: a declined branch has nothing to pin.

Noticed while reading and deliberately left alone: the `snapshot` early-return in `reduceServerEvent` calls no `acceptsSequence`, unlike the `renamed` arm and the shared tail.
That is unrelated to this card and may be deliberate; it is under investigation separately rather than filed blind.
