---
labels: [unverified]
blocked-by: [OW-niwusi]
closed: done
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

## Amended 2026-09-30

`agentpane_pi_steer_probe.py` still waits for the `renamed` event OW-mofuho retired, so it times out before its first turn; OW-niwusi moves it to the handle, and this card waits on that.

## Close note

Measured on the home server on 2026-09-30 with `pi 0.87.1`, `--model openrouter/deepseek/deepseek-v4.1-flash:high`.
On that version, a steer posted into an executing tool batch waits for the whole batch, and only then lands.
`resources/probes/agentpane_pi_steer_probe.py` gained `--turn tool`; the text turn stays the default.
The tool prompt asks for three parallel `bash` calls sleeping 4, 15 and 25 seconds.
The probe reads Pi's stdout tap and posts the marker once the first call has its `tool_execution_end` and the other two are still executing, pinning the cut from that same read.
`checks.tool_placement` reports by tap index where the steered `user` message landed against each call's start, end and `toolResult` and the round's `turn_end`.
It fails a run that cannot show a call still executing when Pi queued the steer.
In four runs Pi put the marker on the `steering` queue while two calls were still running.
It let both finish, emitted all three `toolResult` messages, and closed the round with `turn_end`.
The steered message was the first message of the next round (`placement: "after_batch_turn_end"`), never between calls or between results.
All of this stayed inside one `agent_start`…`agent_settled` span, so the verdict in every run was `steered_into_running_turn`.
This matches `rpc-commands.md` 0.87.1 ("delivered after the current assistant turn finishes executing its tool calls, before the next LLM call").
It also matches the bundled `runLoop`, which polls `getSteeringMessages` only after `turn_end`, and the comment beside `submit()` in `src/server/adapters/pi/process.ts`, so `src/` was not changed.
The new gate was shown red first: posting only after every call had ended failed `tool_placement` and exited 1.
The text turn was re-run once and still passed.
A sequential batch was not exercised: no built-in tool in 0.87.1 declares `executionMode: "sequential"`, and no `toolExecution` setting was in play.
Recorded in `docs/MANUAL_TESTING.md` "Pi's steer waits for the whole tool batch (OW-nufitu)", in D16's Pi paragraph in `docs/DESIGN.md`, and in `resources/probes/README.md`'s steer-probe entry.
