---
labels: [deferral]
---

# fork_probe.py's Pi mid-stream cell still predicts 2 messages after the fork, where pi 0.86.0+ answers 3

Found 2026-10-14 by OW-vijine's runs of `python3 resources/probes/fork_probe.py --backend pi --no-fixtures` on `pi 1.2.0`.
The Pi mid-stream cell reports `midstream_expected_message_count`, set from `stream_expected_messages = 2 if stream_entry else None` in `resources/probes/fork_probe.py`.
After the cell's second-message fork, `get_state` answered `messageCount` 3 in both 1.2.0 runs, where OW-gajesu's `pi 0.85.1` run read 2: since `pi 0.86.0` Pi writes and counts a leading `role: "system"` message (`docs/MANUAL_TESTING.md`, OW-wavini's section, and "Pi's fork, resume and model-restore facts re-measured on `pi 1.2.0` (OW-vijine)", fact 1).
The probe only reports the number and its exit status never reads it, so nothing fails; a reader comparing the two fields sees a mismatch that looks like a moved fact and is not.

In service of the probe's record reading true on the Pi that runs today.
Load-bearing: the prediction must count the system message on a session file written by `0.86.0` or later.
Incidental: whether the prediction is fixed at 3, derived from the branch the probe reads, or dropped.

## Done when

A run of `python3 resources/probes/fork_probe.py --backend pi --no-fixtures` on the installed `pi` prints a `midstream_expected_message_count` equal to the `messageCount` `get_state` answers after the fork, with the version recorded in the commit message.
