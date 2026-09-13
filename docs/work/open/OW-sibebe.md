---
labels: [defect]
---

# The perf harness answers no fork points, so its transcripts now render with no Edit controls

Introduced by OW-roveze, noticed during its execution and deliberately not fixed there.

`e2e/perf-harness.ts` stubs the API's `forkPoints` as `async forkPoints() { return []; }`.
Before OW-roveze that stub cost nothing: the client decided the Edit affordance by counting user messages and never asked the server, so every user message in a perf spec's transcript drew an Edit control exactly as the real app does.

OW-roveze made the affordance conditional on the server's answer.
`createController`'s `refreshForkPoints` now publishes `forkIndices` from that reply, and `Transcript.svelte` draws an `onedit` control only on indices the set names -- so under this harness the set is empty and **no** user message in any perf spec renders an Edit control.

**Why it matters.**
The perf vehicle exists to measure real render cost -- `e2e/` has `App.sort-cost` and `App.streaming-cost` alongside the specs this harness drives -- and it is now measuring a transcript that renders strictly fewer DOM nodes than the app it stands for, by one button per user message.
Whatever those specs report is a floor, not the cost.
The second, quieter half: a future spec that does exercise Edit against this harness finds no controls and reads as a product defect rather than a harness one.

`e2e/harness.ts`, the functional vehicle, was updated in the same change and answers one point per user message, each carrying its index -- that is the shape to copy.

**Load-bearing vs incidental.**
Load-bearing: that the perf harness's fidelity to the real app is the whole of its value, and this is a silent divergence rather than a loud one.
Incidental: whether the fix is to mirror `e2e/harness.ts`'s implementation or to share one.

## Done when

`e2e/perf-harness.ts` answers `forkPoints` with one point per user message carrying that message's transcript index, `bun run test:browser` stays green, and the perf specs' reported numbers are recorded before and after so the size of the divergence is on the record rather than assumed.
