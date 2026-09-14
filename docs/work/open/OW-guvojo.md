---
labels: [unverified]
---

# The Pi smoke probe never records which model answered, so its evidence cannot name one

`resources/probes/agentpane_pi_smoke.py`, the `evidence` dict built in `main()`, and `docs/MANUAL_TESTING.md` ("The Pi smoke probe runs on the home server, end to end through the built server").

The probe records `pi_version` off `pi --version` and nothing about the model.
It sends no `--model` — `buildPiSpawnCommand` in `src/server/adapters/pi/spawn.ts` only appends that flag when the caller supplies one, and `POST /api/sessions` was given `cwd` and `backend` only — so Pi resolved its own default out of the `settings.json` copied into the throwaway `PI_CODING_AGENT_DIR`.
On 2026-09-13 that file selected `deepseek/deepseek-v4.1-flash`, but the run did not read it back, and `settings.json` is a mutable file the owner edits: the section above records one evening in which the selected model changed between two runs three minutes apart.

So the two passing runs recorded in MANUAL_TESTING that day name a `pi` version and cannot name a model, which matters most for exactly the criteria that are model-dependent — whether a tool call happens at all, and how much text a long turn produces before an abort.

## Done when

The probe's evidence carries the resolved model for the session it drove, and a run on the home server shows it populated.

**The fork this card opened is settled, from the code, without a re-run: the server does expose it, so the "exposes no model at all" branch does not fire and nothing needs filing for it.**
Settled 2026-09-13 while closing OW-moradi, by reading the source rather than by measuring, which is why it is worth writing down — the answer is cheap to re-derive and cheap to get wrong.

Where it is and is not:

- **Not** in the attach body.
  `GET /api/sessions/:backend/:id` returns a `SessionSummary` (`src/shared/protocol.ts`), whose fields are `ref`, `cwd`, `preview`, `createdAt`, `updatedAt`, `status`, `isStreaming` — no model.
  So the REST representation the probe already fetched is a dead end, and a reader who checks only there will wrongly conclude the server exposes nothing.
- **Yes** on the SSE stream.
  Both the `snapshot` and the `status` arms of `ServerEvent` carry `model: string | null` (`src/shared/protocol.ts`), filled from `state.model` by `Broadcaster` (`src/server/http/broadcaster.ts`).
  For Pi that value is `PiProcess`'s own `model` field, set from `get_state`'s `data.model` through `modelToInfo` during `start()` and refreshed on later state reads, and handed out by its `snapshot()` (`src/server/adapters/pi/process.ts`).

That makes this a few lines in the probe and no new request: `SseReader` already buffers every event the run produced, so the model was on the wire in both runs of 2026-09-13 and was simply never read off it.
Read it from an event the probe already has and record it in the evidence — do not add a second `get_state` probe beside the server, and do not reach for the attach body.

One caveat for whoever writes it: `model` is `null` until `start()`'s `get_state` answers, so a `status` event can legitimately carry `null` early.
Take it from an event at or after the point the run is already asserting on rather than from the first one that arrives, and treat a still-`null` value at settle time as a finding rather than as a field to leave empty.
