---
labels: [defect]
closed: done
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

## Close note

`agent_requests_seen` in `resources/probes/agentpane_pi_smoke.py` was one whole-stream list assigned at the first turn's idle, before `--tool-check` posts its prompt, so it structurally could not contain anything the tool turn raised — and `docs/HANDOFF.md` finding 42 rested on it being empty.
It is now a dict of per-turn windows built by a `requests_in` helper, each carrying the stream cuts it was taken between: `first_turn` always, and `tool_turn` only under `--tool-check`, opening where the tool prompt is posted and closing at the first cut after that turn reports idle — the idle wait OW-hahohi added at `d628076` is what gives the window an end.
Landed as `2760e01` (probe) and `719a1b4` + `5363a68` (docs).
`agentpane_codex_smoke.py` does not collect the field at all, so nothing was needed there.

Measured on the home server, `pi 0.85.1`, 2026-09-13 into 2026-09-14: four runs across two hands, all `"result": "pass"` and exit 0, every tool window empty.
The empty result was shown to be a real slice rather than a misaddressed one by a throwaway run with the predicate relaxed to also accept `upsert`, whose same two windows carried 42 and 23 entries; that relaxation is not in the committed change.
Full evidence in `docs/MANUAL_TESTING.md`, "The Pi smoke probe measures the tool turn's own requests".

Finding 42 was rewritten to cite that run and to name the version.
An adversarial reader then caught that the rewrite still said Pi "ran" a shell tool, which nothing has ever measured — the probe matches a `toolCall` block and no run records a `toolResult` — so the headline now claims only that a tool call reached the wire with no dialog request beside it, with three limits stated: no `toolResult`, no `trust.json` on this machine, and the field's blindness to any approval that is not a dialog-method `extension_ui_request`.
That same review retired three surviving copies of the old claim: the `pi 0.84.1` table row's unqualified "no approval dialog", the OW-moradi section's present-tense description of the old field, and its quotation of a finding-42 sentence the rewrite had deleted.

One gap found and filed rather than fixed: `tool_turn` is written only after the turn reaches idle, so a request that actually *blocks* the turn is the one case the window cannot witness — OW-johano.
