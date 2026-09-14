---
labels: [defect]
---

# The tool turn's request window is never written when a request actually blocks the turn

`resources/probes/agentpane_pi_smoke.py`, the `if args.tool_check:` block, and specifically the assignment of `evidence["agent_requests_seen"]["tool_turn"]` that follows `stream.wait_for(tool_turn_idle, 180, "the tool turn to return to idle")`.

OW-lapuye scoped that field to each turn's own window, which is what `docs/HANDOFF.md` finding 42 now rests on.
The window is written **after** the tool turn reaches idle.
A dialog request that actually blocks the turn is precisely what stops that turn from reaching idle: the 180-second wait raises, `main`'s `except` arm records `"result": "fail"` with the error naming that wait, and the `tool_turn` key is never written at all.

So the blob for a blocked run carries no tool window, and on that key alone is shape-identical to a bare run.
The run is not silent — it fails, and the error names the wait — but the one field that would say *what* Pi asked for is absent exactly when Pi asked for something.
The field can therefore witness a non-blocking `request` event during the tool turn and cannot witness a blocking one, which is the case it most exists to catch.

Recorded as a limit at the end of `docs/MANUAL_TESTING.md`, in "The Pi smoke probe measures the tool turn's own requests", under the paragraph beginning "Three limits stand on the repaired field."
Nothing has ever observed a live `type: "request"` event from Pi on any run, so this is a hole in the instrument rather than an observed loss.

## Done when

A `--tool-check` run whose tool turn does not reach idle still produces a `tool_turn` window covering what the stream carried between the tool prompt and the failure, and `docs/MANUAL_TESTING.md` records a run that exercised that path — the timeout forced, by a shortened wait or an equivalent, so the failing path is seen writing the window rather than argued to.
