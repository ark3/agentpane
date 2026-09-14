---
labels: [unverified]
---

# Pi's steer is unmeasured against a tool turn, which is the case its own docs describe

`docs/DESIGN.md` D16 now cites a live Pi measurement (OW-yuyofu, home server, 2026-09-14, `pi 0.85.1`, six runs): a prompt posted while a turn is streaming comes back 202 and Pi's `queue_update` names the `steering` queue, and the marker is answered without `agent_settled` falling in between.

Every one of those six runs was a **pure text turn**.
The probe's first prompt asks for a long piece of prose and explicitly tells the model not to use tools, so no turn in the measurement called one.

That is the gap.
Pi's own description of `streamingBehavior: "steer"` is that the text is delivered **after the current tool batch** — the phrase is in the comment beside `submit()` in `src/server/adapters/pi/process.ts`, quoting Pi's `rpc.md`.
So the documented timing rule for a steer has never been exercised on the case it is actually about, and what "after the current tool batch" does to a turn holding several tool calls is unknown here: whether the steered text waits for the whole batch, lands between two calls, or arrives before a pending `toolResult` is mapped.
`resources/fixtures/pi/tool-read.jsonl` and `tool-edit.jsonl` show a tool turn holds two `turn_start`/`turn_end` pairs inside one `agent_start`…`agent_settled` span, so there is a real internal structure for the steer to land somewhere in.

This is filed as `unverified` rather than `defect` because nothing is known to be broken: the adapter sends the same `streamingBehavior: "steer"` either way, and `src/server/adapters/pi/reducer.ts` maps events the same way either way.
What is missing is evidence.

## Done when

A run recorded in `docs/MANUAL_TESTING.md`, naming the `pi` version, shows a prompt posted mid-turn while Pi is executing a tool, and says where in the tool batch the steered text landed — read off Pi's own stdout events, not inferred from arrival timestamps.

`resources/probes/agentpane_pi_steer_probe.py` is the vehicle and already does almost all of it: it taps Pi's stdout through a PATH shim, pins the tap's line count immediately before the POST, and classifies on `queue_update` plus the `agent_settled` boundary.
What it needs is a first prompt that reliably calls a tool and stays in the batch long enough to be steered into, plus a wait that confirms a `toolCall` is in flight rather than that the session is merely streaming.
`resources/probes/agentpane_pi_smoke.py`'s `--tool-check` block is the prior art for provoking a tool call, and OW-hahohi is the worked example of why waiting for the *right* turn matters: that card exists because a phase posted its prompt 42 ms after a `toolCall` arrived and could not tell which turn it had hit.

Whatever the answer, add it to D16's Pi paragraph, which currently names this as one of three things its measurement does not reach.
