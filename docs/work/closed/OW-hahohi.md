---
labels: [defect]
closed: done
---

# The Pi smoke probe abort phase measures less than it claims, and under --tool-check may abort the wrong turn

`resources/probes/agentpane_pi_smoke.py`, section `-- 4. abort, then shutdown without an orphan --`, and the `--tool-check` block immediately above it.
Both halves observed on the home server 2026-09-13, `pi 0.85.1`, in the runs recorded in `docs/MANUAL_TESTING.md` ("The Pi smoke probe runs on the home server, end to end through the built server").

Two defects in the same phase.

**Under `--tool-check` the long prompt is posted while the tool turn is still in flight.**
The tool check waits for a `toolCall` block to reach the wire and returns the moment it sees one; it never waits for that turn to reach `streaming=false`.
The abort section then posts the long prompt straight away.
In the measured run the `toolCall` landed at 23:13:06.302 and the abort section saw `streaming=true` at 23:13:06.344, 42 ms later — far too soon to be a fresh turn.
The abort check's own guard, `pre_abort_streaming is not True`, cannot tell the two turns apart, so it passes either way, and what the run proves about `/abort` under `--tool-check` is unknown.
The bare run is unaffected and its abort evidence is clean.
Incidental to this, and now filed as OW-yuyofu so that repairing the overlap does not take it with it: the server answered 202 to a prompt posted while a Pi turn was active, where the Claude Code adapter rejects one (`docs/MANUAL_TESTING.md`, OW-jihete).
That is a cross-backend contract question, not a defect in this probe, and nothing here should be written as though it were settled.

**The long prompt does not produce a long turn.**
It asks for the integers 1 through 10000, one per line.
The assistant transcript stood at 472 characters (bare run) and 467 (`--tool-check` run) when the abort landed, and the abort was answered in 16 ms and 36 ms.
The model declines the task and explains itself instead, so the phase aborts a turn that was producing almost nothing — it exercises far less buffered-output teardown than the prompt implies, which is the whole reason the prompt is shaped that way.
The same prompt sits in `agentpane_codex_smoke.py`, so check whether it behaves there before changing only one.

**Two measurement hazards in the same phase, for whoever repairs it.**
Neither is a defect on its own and both would cost a re-run to rediscover.
`max_assistant_length` is the longest assistant message *for the session*, not the aborted turn's own length; it happened to be the long turn in both runs of 2026-09-13 (472 and 467, against a 67-character first reply), so the numbers above are right — but the post-abort growth check compares that maximum, and a shorter message arriving after the abort would not move it.
And the evidence's timestamps are SSE *arrival* stamps, not wait durations: subtracting `checks.startup.timestamp` from `rename.renamed_at` gives 5 ms on the bare run and **−2 ms** on the `--tool-check` run, because the `renamed` event was already buffered before the wait began.
The abort's 16 ms is a genuine request-to-event interval because the request is stamped immediately before it is sent; nothing else in the blob should be read as a duration.

## Done when

A run of `agentpane_pi_smoke.py --tool-check` on the home server shows the aborted turn is demonstrably the long one and not the tool turn — the evidence distinguishes them, rather than a reader inferring it from timestamps.
Whether the long turn is made genuinely long is a judgement: if it is left as it is, say so in the probe beside the prompt, because the prompt as written asserts an intent the run does not deliver.

## Close note

Both halves landed: `787e2dd`, `d3eba93`, `d628076` and `666e302`, all in `resources/probes/agentpane_pi_smoke.py` and `docs/MANUAL_TESTING.md`.

**The overlap is fixed and the fix is asserted, not inferred.**
The `--tool-check` block now waits for its own turn to reach `streaming=false` and records it in `checks.tool_output` as `turn_streaming_at` / `turn_idle_at` / `turn_idle_event_type`.
Section 4 then reads `last_streaming` immediately *before* posting the long prompt, raises unless it is `False`, and records `checks.abort.streaming_before_long_prompt`.
That field is what distinguishes the turns: the pre-existing `streaming_at_abort: true` guard answers `true` whichever turn is running, which is how the OW-moradi `--tool-check` run passed while aborting an unknown turn.

**Seen red first.**
With the fix in place except for the idle wait — the old behaviour of posting the long prompt the moment the `toolCall` block arrived — the run reported `"result": "fail"`, exit 1, `RuntimeError: a turn was still active when the long prompt was posted, so the aborted turn would not be the long one (last reported state: True)`, with `checks` stopping after `tool_output` and no `abort` check written.
So the guard fails on exactly the condition the earlier run met silently.

**Four passing runs, two hands.**
`--tool-check` and bare on the implementer's branch, then both again from the main checkout at `d628076` after review corrected the comments and prose.
All four `"result": "pass"`, exit 0, each run's own `checks.model` reporting `openrouter/deepseek/deepseek-v4.1-flash`, all on `pi 0.85.1`, 2026-09-13.
Written up in `docs/MANUAL_TESTING.md`, "The Pi smoke probe's abort is now provably aimed at the long turn"; the stale claim in the OW-moradi section above it is pinned to `967b319` and forward-links to the new section.

**The long prompt was left as written, which was the judgement this card left open.**
It still asks for the integers 1 through 10000 and the model still declines and explains itself: 414, 427, 449, 467, 467 and 472 characters across the six runs on `pi 0.85.1` that day.
Not reworded because `agentpane_codex_smoke.py` sends the byte-identical string and nothing has measured how Codex answers it, so changing one probe on a guess would diverge them for no reason anybody could check.
Instead a comment at the prompt states what it asks for against what it delivers, `assistant_length_at_abort` now reports the pre-abort length per run (the field the Codex probe already carried), and no threshold is asserted on it — model compliance is not something a probe can require.
What the phase establishes is therefore narrower than the prompt reads: `/abort` is accepted against a streaming turn and the turn stops and stays stopped, and nothing about tearing down a large buffered transcript.

**Two limits this card names and does not fix, now carried by cards.**
OW-fagemo: neither probe can show a large-transcript teardown, and the Codex side should be measured before either prompt is changed.
OW-sofige: `assistant_length_at_abort` is a session maximum, so it cannot attribute itself to the aborted turn, and the post-abort growth check inherits the same blind spot.
Both are recorded as limits in the new `docs/MANUAL_TESTING.md` section too, so a reader of the evidence meets them where the numbers are.

A third finding was reviewed and left alone: the `pre_abort` cut is taken immediately before the request, so a turn that ended of its own accord during the abort's round trip still satisfies the phase — the probe's own comment already names it, and the doc section now says so as well.
Closing that needs a causal signal the SSE stream does not carry.
The evidence blobs are at `/tmp/hahohi-red.log`, `/tmp/hahohi-toolcheck.log`, `/tmp/hahohi-bare.log`, `/tmp/hahohi-main-toolcheck.log` and `/tmp/hahohi-main-bare.log` until that directory is cleared; every number above is in the write-up, which is the durable copy.
