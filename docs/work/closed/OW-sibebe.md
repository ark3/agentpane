---
labels: [defect]
closed: done
---

# The perf harness answers no fork points, so its transcripts now render with no Edit controls

Introduced by OW-roveze, noticed during its execution and deliberately not fixed there.

`e2e/perf-harness.ts` stubs the API's `forkPoints` as `async forkPoints() { return []; }`.
Before OW-roveze that stub cost nothing: the client decided the Edit affordance by counting user messages and never asked the server, so every user message in a perf spec's transcript drew an Edit control exactly as the real app does.

OW-roveze made the affordance conditional on the server's answer.
`createController`'s `refreshForkPoints` now publishes `forkIndices` from that reply, and `Transcript.svelte` draws an `onedit` control only on indices the set names -- so under this harness the set is empty and **no** user message in any perf spec renders an Edit control.

**Why it matters.**
The perf vehicle exists to measure real render cost -- `e2e/perf-probe.ts` drives this harness and prints the table; the sibling counters `App.sort-cost.test.ts` and `App.streaming-cost.test.ts` live in `src/client/` and do not touch it (amended 2026-09-13: the card said they were in `e2e/`) -- and it is now measuring a transcript that renders strictly fewer DOM nodes than the app it stands for, by one button per user message.
Whatever those specs report is a floor, not the cost.
The second, quieter half: a future spec that does exercise Edit against this harness finds no controls and reads as a product defect rather than a harness one.

`e2e/harness.ts`, the functional vehicle, was updated in the same change and answers one point per user message, each carrying its index -- that is the shape to copy.

**Load-bearing vs incidental.**
Load-bearing: that the perf harness's fidelity to the real app is the whole of its value, and this is a silent divergence rather than a loud one.
Incidental: whether the fix is to mirror `e2e/harness.ts`'s implementation or to share one.

## Done when

`e2e/perf-harness.ts` answers `forkPoints` with one point per user message carrying that message's transcript index, `bun run test:browser` stays green, and the numbers `bun e2e/perf-probe.ts` prints against a production build are recorded before and after, in `docs/MANUAL_TESTING.md`, so the size of the divergence is on the record rather than assumed.

## Close note

`e2e/perf-harness.ts`'s `forkPoints` now resolves the ref to its session and answers one point per user message carrying that message's transcript index -- the shape `e2e/harness.ts` answers, keyed per ref because this harness drives several sessions at once.
Landed as 1b860d8 on `main`.

The defect was shown red before it was fixed: driving the built harness at `sessions: 2, seedTurns: 5` and counting `.conversation [data-edit]` gives **0** on the old harness and **5** on the new one, one per seeded user message, which is what the real app draws.
That count was run twice, once by the implementer and once independently by the dispatching session against `02a4494^` and `02a4494`.

Probe figures before and after are recorded in `docs/MANUAL_TESTING.md`, "Observed perf-harness cost before and after answering fork points (OW-sibebe)", measured 2026-09-13 on the home server with `bun 1.3.14` and `@playwright/test 1.62.1` on the production-build recipe in `e2e/perf-probe.ts`'s docblock.
The finding there is worth carrying forward: the per-event streaming cost barely moves (0.1-0.5ms on the selected rows, at or inside the run-to-run spread the 400-session rows already show), and the background rows do not move at all.
So the card's premise that the reported numbers were a floor holds, but the floor is shallow -- what the empty answer was really hiding was first-paint and node-count fidelity, not per-event cost.

`bun run check` green (49 files, 1043 tests) and `bun run test:browser` green (20 passed).

Amended under step 1 before dispatch: the card said `App.sort-cost` and `App.streaming-cost` live in `e2e/`; they are `src/client/App.sort-cost.test.ts` and `src/client/App.streaming-cost.test.ts` and never touch this harness.
The done-condition's "the perf specs' reported numbers" was sharpened to the table `bun e2e/perf-probe.ts` prints, recorded in `docs/MANUAL_TESTING.md`.

Noticed and not done, filed as OW-bagofa: no spec asserts the perf harness draws Edit controls, so nothing catches this regressing again.
