---
labels: [unverified]
closed: done
---

# AGENTS.md states that a mid-stream Pi fork abandons the in-flight turn, on evidence that run itself does not carry

**Runs on the home server** as of 2026-09-13, which has `pi 0.85.1`.
This card carried `work-laptop` until then; the run it asks for no longer needs a trip, and it will measure 0.85.1 rather than the 0.84.2 cited below.

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

on the home server, with `MANUAL_TESTING.md` carrying its `pi_rewind` values for `midstream_expected_message_count` against the observed count, `midstream_abandoned_file_messages`, `moved_file_on_disk_at_fork` and `moved_file_messages_at_fork`.

Whatever the mid-stream fields say, AGENTS.md's sentence under "Evidence" is brought into line with what the run actually carries — confirmed on stronger evidence, or narrowed to what is proven, or corrected.
Leaving that sentence untouched because the run agreed with it is not a close: the defect is that it asserts more than its evidence, and a second thin run does not repair that.

The OW-pifowo section's two flagged passages resolve to whichever reading the disk fields support, rather than staying "unsettled", and `src/server/adapters/pi/process.ts`'s `fork()` docblock says the same thing and is corrected with them.

## Close note

Ran `python3 resources/probes/fork_probe.py --backend pi --no-fixtures` once on the home server, 2026-09-15, `pi 0.85.1`, exit 0.
The probe copies `~/.pi/agent/settings.json` into a throwaway state home and passes no `--model`, and `get_state` reported `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"` in every state read the record carries.
The write-up is `docs/MANUAL_TESTING.md`, "Pi's mid-stream fork, and the forked file on disk, re-measured at the instrument (OW-gajesu)"; the run landed in 73415d8, 9f310be, 6c448e8 and 969cb5f.

The four values the card asked for: `midstream_expected_message_count: 2` against an observed `messageCount: 2` (forked at entry `52938741`, `Say exactly: DELTA`, the second user message); `midstream_abandoned_file_messages` = eight messages ending with the streaming turn's own user message and an assistant entry whose text is `""`; `moved_file_on_disk_at_fork: true`; `moved_file_messages_at_fork` = the rewound prefix `ALPHA -> ALPHA`.
`active_file_moves_at_fork: true` for the third run running.

**AGENTS.md was narrowed, not confirmed.**
The run earns that a mid-stream fork stops the turn and that the streamed-into file ends with the prompt plus an empty assistant entry — stronger than the 0.84.2 settle alone.
It does not earn "abandons the in-flight turn" in the sense the sentence implied, because the `pi_rewind` cell fires its fork on `agent_start` alone, with no accumulating-delta gate and no count of what had streamed, where its sibling `codex_fork_mid_stream` waits on five deltas and reports `unearned` without them.
The session files' timestamps put this fork ~2.2s after the prompt on a reasoning model, so a discarded reply and a reply not yet begun are indistinguishable in the record.
That gap is filed as **OW-sededi**, which carries the delta gate and the sentences that land on its answer.
The narrowing reached AGENTS.md, `docs/DESIGN.md` D15, the new MANUAL_TESTING section, the probe's module docstring, and `src/client/controller.ts` `forkAndSubmit` — the site `src/client/App.svelte` names as where that evidence lives, which had still been citing the 0.84.2 run alone.

**The disk-timing flag is settled enough to retire `false`.**
This run read `true` with the `get_state` back as the first round-trip after the `fork`, where the 2026-08-19 run took it and read `false`.
Recorded as what it is: `false` did not survive a run at its own instrument, but `pi` and the machine both changed between the two runs, so this is not a disproof of the latency hypothesis and one sample of a race is not an invariant.
Both flagged passages in the OW-pifowo section and the contested paragraph in OW-yudoni now say that, as do the `fork()` docblock in `src/server/adapters/pi/process.ts` and the probe's own comments.
The consequence — a discarded fork leaves a real session file for `src/server/sessions/walk.ts` to walk into the picker — is recorded as live and pointed at **OW-vezipo**, which owns that argument; no picker decision was taken here.

Adversarially read by a dispatched reader against the raw record, which is what caught the missing delta gate and the `controller.ts` citation; `bun run check` passes on `main` (50 files, 1094 tests).
