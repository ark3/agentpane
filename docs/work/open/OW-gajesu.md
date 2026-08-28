---
labels: [unverified, work-laptop]
---

# Whether a fork Pi has not yet been prompted from exists on disk is unsettled, and a discarded fork may leave a phantom session in the picker.

**Work laptop:** needs a live Pi run.

`resources/probes/fork_probe.py` `pi_rewind` cell, `docs/MANUAL_TESTING.md` OW-pifowo and OW-yudoni sections

Two runs of the same cell read opposite answers for
`moved_file_on_disk_at_fork` — `false` on 2026-08-19 (OW-pifowo), `true` on
2026-08-20 (OW-yudoni). The second had inserted a `get_messages` round-trip
between the `fork` and the `get_state`, so they were not measuring at the same
moment and the added latency is a candidate explanation for the whole
difference. The `get_state` is now back to being the first round-trip after the
`fork`, where OW-pifowo took it, and the cell records three further fields that
neither run had.

## Why the answer matters beyond tidiness

MANUAL_TESTING's OW-pifowo section concluded from `false` that *"a fork with no
subsequent prompt writes no file and holds no conversation the abandoned F1
does not already carry. Discarding it before prompting loses nothing."* On
`true` that conclusion inverts: forking leaves an F2 in the sessions directory,
and `src/server/sessions/walk.ts` readdir-walks that directory to build the
picker. A user who scrolls up, clicks edit, forks, and then cancels would be
left looking at a session they never had a conversation in. Both readings are
recorded in that section as open pending this run.

`moved_file_messages_at_fork` is what decides the second half without a second
trip: it is F2's on-disk messages read before any prompt. Empty or absent means
there is nothing for the picker to show; populated means the filtering question
is real, and it can then be answered cold on the home server against
`src/server/sessions/index.ts` rather than needing Pi again.

## The mid-stream cell's own evidence was thin

OW-yudoni's conclusion that a mid-stream fork abandons the running turn rests on
`isStreaming: false` plus an `agent_settled` carrying no assistant text. The two
other things that run recorded were not evidence: it forked at the **first**
user message, where exclusive semantics empty the new branch whatever became of
the turn, so `messageCount: 0` was a tautology; and it read the new branch
rather than the file the turn was streaming into, which is where a partial reply
would have landed. The cell now forks at the second entry
(`midstream_expected_message_count`) and reads the abandoned file
(`midstream_abandoned_file_messages`).

## Done when

One run of

```
python3 resources/probes/fork_probe.py --backend pi --no-fixtures
```

on the work laptop, with `MANUAL_TESTING.md` carrying its `pi_rewind` values for
`moved_file_on_disk_at_fork`, `moved_file_messages_at_fork`,
`midstream_expected_message_count` against the observed count, and
`midstream_abandoned_file_messages` — and the OW-pifowo section's two flagged
passages resolved to whichever reading the run supports, rather than left as
"unsettled". `src/server/adapters/pi/process.ts`'s `fork()` docblock says the
same thing and is corrected with them.
