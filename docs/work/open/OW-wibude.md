---
labels: [defect]
---

# A Pi prompt queued behind another goes out without streamingBehavior before the first run's agent_start, and Pi's refusal reaches the user as a 500

Filed 2026-10-14 from OW-kokotu's live run on the home server, `pi 1.2.0`, pinned `openrouter/deepseek/deepseek-v4.1-flash:high`; see `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "The window, through agentpane's prompt route".

In service of D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects"): on Pi a prompt sent while a run is going steers it, and is never refused.

## What happens

Two POSTs to a Pi session's prompt route released together: in four runs of four, the stdin tap held both `prompt` commands without `streamingBehavior`, Pi refused the second with `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`, and the route answered that POST 500 `internal_error`.
No SSE `error` event was sent for it.
A POST sent after the first's 202 (about 4 ms later) went out with `"steer"`, was answered `queued`, and ran inside the same run, as D16 says.

The chain, read at the code:
- `SessionManager.submit` in `src/server/http/session-manager.ts` runs a session's submits one at a time through `#serially`, so the second `adapter.submit` is built the moment the first resolves on Pi's `prompt` response.
- `PiAdapter.submit` in `src/server/adapters/pi/process.ts` adds `streamingBehavior: "steer"` only when `this.state.isStreaming`.
- `reducePiNotification` in `src/server/adapters/pi/reducer.ts` sets `isStreaming` at `agent_start`, which Pi 1.2.0 writes after the `prompt` response, in a later `read()` every time in fifteen samples.
- Pi counts the session busy from accepting the run, before even its own response (the same section, "The window, at Pi's RPC"), so the bare second prompt is refused.
- The adapter's rejection is a plain `Error`, so the `fetch` catch in `src/server/http/app.ts` maps it to 500 `internal_error`, not the 400 `backend_refused` a `BackendRefusedError` gets.

## Direction

`this.state.isStreaming ?` in `submit()` is a guard that reads a flag owned by the event stream to decide something Pi decides on its own clock, and the window between them is exactly what it misses; patching that one window (a second flag set on send, cleared on `agent_start`) would leave the guard standing and its next gap undiscovered.
The run measured what retires it: on `pi 1.2.0` a single `"steer"` prompt sent to an idle Pi was answered `{"disposition": "started"}` and ran an ordinary turn (run 5, the probe's `idle_steer` cell), so sending `"steer"` on every prompt makes the adapter's view of busy irrelevant to admission.
Whether anything else reads `isStreaming` to decide a submit, and whether `"steer"` on idle holds for an image-carrying prompt, are for the executor to confirm at the source.

`src/server/adapters/pi/process.test.ts` fakes the refusal as `"Agent is streaming; specify streamingBehavior"`, which is not 1.2.0's wording; the test matches only `/streamingBehavior/`.
The second paragraph of the `submit()` comment describes this race as measured and must change with it.
D16's body cites `pi/process.ts:291-294` for the steer, a line reference long stale; fix it to a symbol address in the same change.

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, shown red first, asserts that a prompt submitted while the adapter has seen no `agent_start` carries `streamingBehavior: "steer"`.
- The `isStreaming` conditional in `PiAdapter.submit` is gone, not supplemented.
- `python3 resources/probes/agentpane_pi_prompt_window_probe.py --part agentpane` re-run on the home server shows both concurrent POSTs answered 202 and both stdin prompts carrying `"steer"`, recorded in `docs/MANUAL_TESTING.md` with the `pi` version.
- `bun run check` passes.
