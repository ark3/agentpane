---
labels: [unverified]
---

# Pi 1.2.0 counts a session busy from the moment a run starts, before agent_start, and a prompt an extension handles starts no run; what agentpane's submit makes of either is unmeasured

Filed 2026-10-14 from Pi's changelog, read against `submit()` in `src/server/adapters/pi/process.ts`; nothing here was run.

Two Pi changes touch how a prompt is admitted, and agentpane's handling of each was built before it.

1. `1.2.0`, marked breaking in Pi's changelog: the session counts as busy while a run is starting, including during `before_agent_start`, and an abort sent in that window aborts the run once it starts.
   `submit()` adds `streamingBehavior: "steer"` only when `state.isStreaming` is true, and `reducePiNotification` in `src/server/adapters/pi/reducer.ts` sets that on `agent_start`.
   So a second prompt sent after Pi accepted the first but before its `agent_start` goes out bare, and the `submit()` comment's own reading of `rpc.md` is that a bare `prompt` while busy is rejected.
   Whether Pi now rejects it, how wide that window is with the pinned model, and what agentpane answers through its submit route are all unknown.
   The abort half reads as a fix rather than a risk — an abort right after a submit used to race the start — but that too is a reading.
2. `0.99.0`: a successful `prompt` response carries `data.disposition`, and per Pi's `docs/rpc.md`, `"handled"` means no run started, so no `agent_settled` will come; an extension command consuming the prompt is the case.
   The `prompt` arm of `PiResponse` in `src/server/adapters/pi/protocol.ts` has no `data`, and `submit()` ignores the response body.
   Whether anything in agentpane or either client waits for a turn that will not come after a handled prompt is unknown; which prompts Pi `1.2.0` hands to an extension in RPC mode, given that agentpane sends a leading `/` as text (OW-73), is part of the question.

In service of a prompt the user sends either running or being refused visibly, never sitting accepted with nothing happening.
Load-bearing: the version, and that the first is measured in the window between the `prompt` response and `agent_start`, not merely "during a turn", which OW-yuyofu already settled on `0.85.1`.

## Done when

A live run on the home server, on the installed `pi` with the pinned `--model openrouter/deepseek/deepseek-v4.1-flash:high`, is recorded in `docs/MANUAL_TESTING.md` with the version, settling: what Pi answers a second bare `prompt` sent before the first's `agent_start`, both at Pi's RPC and through agentpane's submit route; and whether any prompt agentpane can send yields `disposition: "handled"`, and if one does, what agentpane's state and each client show after it.
`resources/probes/agentpane_pi_steer_probe.py` is the nearest vehicle to extend or copy from.
Whatever the run shows, each finding that agentpane mishandles gets its own `defect` card citing this run, and the `submit()` comment states what was measured with the version.
