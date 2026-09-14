---
labels: [defect]
---

# agent_requests_seen is captured before the tool prompt, so no smoke-probe run has ever covered the tool turn

`resources/probes/agentpane_pi_smoke.py`, the assignment of `evidence["agent_requests_seen"]` under the comment "Any blocking request Pi raised is worth recording either way", and `docs/HANDOFF.md` finding 42.
The same shape exists in `resources/probes/agentpane_codex_smoke.py` if it collects the field the same way; check before assuming it does not.

The field is assigned exactly once, immediately after the first turn's `idle` check and **before** the `if args.tool_check:` block that posts the tool prompt.
It is a snapshot of the stream as of the first turn going idle, and it is never refreshed.
So in a `--tool-check` run it structurally cannot contain anything the tool turn raised: the tool prompt had not been sent when the snapshot was taken.

That invalidates the evidence column of `docs/HANDOFF.md` finding 42 — "**Pi ran a shell tool with no approval dialog** … `--tool-check` run; `agent_requests_seen` empty".
The finding may well be true; it has simply never been measured.
It was recorded on the work laptop against `pi 0.84.1`, and the home-server runs of 2026-09-13 on `pi 0.85.1` reproduced the same empty field with the same defect (`docs/MANUAL_TESTING.md`, "The Pi smoke probe runs on the home server, end to end through the built server").
Finding 42 is left standing in `docs/HANDOFF.md` with the defect named against it rather than deleted, because deleting an unmeasured finding loses the question it was asking.

A second limit is worth carrying into whatever replaces it, and is not a defect: `agent_requests_seen` filters on `event["type"] == "request"`, and the Pi adapter's only source of that event is an `extension_ui_request` carrying a dialog method (`src/server/adapters/pi/reducer.ts`, the `extension_ui_request` arm; the fire-and-forget methods are dropped there deliberately).
An approval arriving by any other mechanism is invisible to this field however it is scoped, so "empty" will never mean "Pi asked nothing" — only "no dialog request reached the wire".

## Done when

A `--tool-check` run on the home server produces evidence that covers the tool turn's own window — the requests seen between the tool prompt and that turn settling, distinguishable from the first turn's — and `docs/HANDOFF.md` finding 42 is rewritten to say what that run actually measured, naming the `pi` version it measured it on.
OW-hahohi has since landed (`d628076`), so the tool turn's end now exists: `tool_turn_idle` waits for that turn to return to idle and `checks.tool_output` records `turn_streaming_at` and `turn_idle_at`.
The window this card needs an end for is therefore already bounded in the probe, and what remains is to scope the request capture to it.
