---
labels: [unverified, work-laptop]
---

# AGENTS.md states that a mid-stream Pi fork abandons the in-flight turn, on evidence that run itself does not carry

**Work laptop:** needs a live Pi run.

`resources/probes/fork_probe.py` `pi_rewind` cell, `docs/MANUAL_TESTING.md` OW-pifowo and OW-yudoni sections.

Rewritten 2026-09-10 after the owner reviewed the close for OW-puduro.
This card used to lead on whether a fork Pi has not yet been prompted from exists on disk, and on the phantom picker row a discarded fork might leave.
That is no longer the reason it is open: the owner does not care about an abandoned fork's on-disk residue, and the sibling card on Claude Code, OW-fejota, was declined for exactly that.
The disk fields stay in the run because the same command emits them, not because a decision waits on them.

## What the card is now in service of

AGENTS.md records under "Evidence", flatly and as settled: *"forking during a streaming turn succeeds but abandons the in-flight turn"*, live on the work laptop, 2026-08-20, `pi 0.84.2`.
`docs/MANUAL_TESTING.md`'s OW-yudoni section then documents that two of the three things that run observed were not evidence for it.
It forked at the **first** user message, where exclusive semantics empty the new branch whatever became of the turn, so `messageCount: 0` was a tautology rather than corroboration.
And it read the new branch rather than the file the turn was streaming into, which is where a partial reply would have landed.
What survives is `isStreaming: false` plus an `agent_settled` carrying no assistant text.

So a claim the project states without hedging rests on one observation, and the passage that admits this sits in a document the reader of AGENTS.md has no reason to open.
That gap is the whole of why this card is still open.

The cell has already been fixed for it: it forks at the second entry, recording what it expected in `midstream_expected_message_count`, and reads the abandoned file in `midstream_abandoned_file_messages`.
Nobody has run it since.

## The disk fields, riding along

Two runs of the same cell read opposite answers for `moved_file_on_disk_at_fork` — `false` on 2026-08-19 (OW-pifowo), `true` on 2026-08-20 (OW-yudoni).
The second had inserted a `get_messages` round-trip between the `fork` and the `get_state`, so they were not measuring at the same moment and the added latency is a candidate explanation for the whole difference.
The `get_state` is now back to being the first round-trip after the `fork`, where OW-pifowo took it.
`moved_file_messages_at_fork` reads F2's on-disk messages before any prompt.

Record both whatever they say.
Do not reopen the picker question off the back of them: OW-vezipo is the live card on telling sessions apart in the list, and it is where that argument belongs if it is ever had.

## Done when

One run of

```
python3 resources/probes/fork_probe.py --backend pi --no-fixtures
```

on the work laptop, with `MANUAL_TESTING.md` carrying its `pi_rewind` values for `midstream_expected_message_count` against the observed count, `midstream_abandoned_file_messages`, `moved_file_on_disk_at_fork` and `moved_file_messages_at_fork`.

Whatever the mid-stream fields say, AGENTS.md's sentence under "Evidence" is brought into line with what the run actually carries — confirmed on stronger evidence, or narrowed to what is proven, or corrected.
Leaving that sentence untouched because the run agreed with it is not a close: the defect is that it asserts more than its evidence, and a second thin run does not repair that.

The OW-pifowo section's two flagged passages resolve to whichever reading the disk fields support, rather than staying "unsettled", and `src/server/adapters/pi/process.ts`'s `fork()` docblock says the same thing and is corrected with them.
