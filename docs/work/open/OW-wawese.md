---
labels: [deferral]
---

# The smoke probes' post-abort growth check takes its baseline when the probe next polls, not at the idle event, so text arriving just after idle is never checked

Both live smoke probes, `resources/probes/agentpane_pi_smoke.py` and `resources/probes/agentpane_codex_smoke.py`, check that an aborted turn stops: they read the turn's rows with `turn_messages` (`resources/probes/agentpane_live_support.py`) "at idle", sleep 1.5 s, read again and require the two to match.
The "at idle" read is `turn_messages(stream.snapshot(), ...)` (Codex: `reconnect.snapshot()`) taken after `wait_for(aborted_idle, ...)` returns, and `SseReader.wait_for` polls every 50 ms.
So anything that lands between the `status{isStreaming:false}` event and that poll becomes part of the baseline and can never fail the check.
Example: `status{isStreaming:false}`, then an `upsert` growing the aborted message within ~50 ms, then the poll — the run passes.

Found by the adversarial read of OW-sofige on 2026-09-30.
The weakness predates OW-sofige, which only changed what the check compares (the turn's own rows instead of the session's longest message); OW-sofige's write-up in `docs/MANUAL_TESTING.md`, "The smoke probes abort the long turn's own text, twenty thousand characters in (OW-sofige)", names this limit and so cannot say whether the 20005→20009 and 20005→20074 growth it saw between the cut and idle arrived before idle or after it.

Judged not worth blocking OW-sofige on: no run has shown text arriving after idle, and fixing it needs fresh live runs of both probes.

## What this needs

Take the baseline at the idle event itself.
The transcript replay makes that cheap: have `aborted_idle` return the event's position as well as its timestamp, and read `turn_messages(events[:position + 1], ref, abort_start)` as the baseline instead of a fresh snapshot.
Then the comparison covers everything from idle onwards.

## Done when

Both probes take the growth check's baseline from the events up to and including the idle event, and the post-poll `snapshot()` read is gone from that baseline.
Seen red first: a synthetic event list (in the shape of OW-sofige's throwaway `synthetic_red.py`, which built `ServerEvent`s by hand) with an upsert growing the aborted message after the idle `status` but before the next poll must fail the new check, and the record of that is in the write-up.
A run of each probe on the home server passes, written up in `docs/MANUAL_TESTING.md` with the CLI versions, and the OW-sofige section's sentence naming this limit is updated to point at the fix.
