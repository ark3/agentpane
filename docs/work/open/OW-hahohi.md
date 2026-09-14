---
labels: [defect]
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
