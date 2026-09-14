---
labels: [unverified]
---

# Neither smoke probe can show that /abort tears down a large buffered transcript

Both smoke probes' abort phase sends the same prompt — "Do not use tools. Write the integers from 1 through 10000, one per line, and continue until every integer is written." — in `resources/probes/agentpane_pi_smoke.py` (section `-- 4. abort, then shutdown without an orphan --`) and `resources/probes/agentpane_codex_smoke.py`.
The prompt's whole purpose is to put a large buffered transcript in flight so the abort has something substantial to tear down.

As of `pi 0.85.1` on 2026-09-13 it does not.
The model declines the task and explains itself instead, in all six runs measured that day: pre-abort transcripts of 414, 427, 449, 467, 467 and 472 characters, with the abort answered in 16 to 36 ms.
See `docs/MANUAL_TESTING.md`, "The Pi smoke probe's abort is now provably aimed at the long turn" (OW-hahohi), and the section above it for the OW-moradi pair.
OW-hahohi deliberately left the prompt as written and documented the gap at the site rather than guessing at a wording, because the Codex probe sends the byte-identical string and nothing has measured how Codex answers it.

So what the phase establishes is narrower than it reads: `/abort` is accepted against a streaming turn and the turn stops and stays stopped.
Nothing in the repo shows agentpane's abort path handling a genuinely large in-flight transcript, on either backend.
That is the hole this card names.

## What this needs

Measure the Codex probe's abort phase first — nobody has read what that string does on Luna, and it may already produce volume there, in which case only the Pi side needs a new prompt and the two probes diverge for a reason worth recording.
Then find a prompt the pinned models actually comply with at length.
An essay or a long enumeration the model has no reason to refuse is the obvious direction; counting to 10000 reads to a model as a pointless token sink, which is why it declines.
Do not assert a length threshold in the probe: model compliance is not something a probe can require, and a threshold turns a model's mood into a red run.
The probes already report the pre-abort length per run (`assistant_length_at_abort`), which is the field a reader checks.

Note that field's limit, carried by OW-sofige: it is a session maximum, not the aborted turn's own length, so a bigger number does not by itself prove the long turn produced it.

## Done when

A run of each probe on the home server shows a pre-abort transcript of a different order of magnitude than a few hundred characters — tens of kilobytes, say — with the abort still answered and the transcript still not growing afterwards, and the runs are written up in `docs/MANUAL_TESTING.md` naming the version each was measured on.
If a backend's pinned model refuses every reasonable long prompt, that is the answer: record it in the probe beside the prompt and in `docs/MANUAL_TESTING.md`, and close this card on that evidence rather than on a wording nobody found.
