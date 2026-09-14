---
labels: [unverified]
closed: done
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

## Close note

Done. The Pi smoke probe now records the model that answered, read off the SSE stream it was already buffering.

What was built: `resources/probes/agentpane_pi_smoke.py` gained a `resolved_model()` scan immediately after the `idle` check (~20 lines, commit `1c749a8`). It walks `SseReader`'s buffer in reverse for the latest `snapshot` or `status` event for the run's real ref carrying a non-empty string `model`, and records `evidence["checks"]["model"]` as `{"result", "at", "model", "event_type"}`. Where no such event exists it raises, so a Pi that stops reporting a model stops the probe rather than leaving the field quietly empty — the card's caveat about early `null` values, honoured by taking the settled event rather than the first one.

No second `get_state` beside the server and no new request, as the card directed. The attach body was correctly left alone: `SessionSummary` has no model field.

How it was verified: two live runs on the home server, 2026-09-13, `pi 0.85.1`. The implementer's run at the probe commit, and an independent re-run from the main checkout at `9b0bfc1` by the dispatching session rather than a report taken on trust. Both reported `"result": "pass"` with `checks.model` naming `openrouter/deepseek/deepseek-v4.1-flash` off a `snapshot` event at the instant the first turn returned to idle. The check was also seen red first, by reading a field name that does not exist: `RuntimeError: no settled snapshot or status event named the model Pi resolved`, exit 1, `checks` stopping at `idle`.

One finding worth carrying forward: the string the server reports is not the string the settings file names. `~/.pi/agent/settings.json` selects `deepseek/deepseek-v4.1-flash`; what comes back through `get_state` and out over SSE is `openrouter/deepseek/deepseek-v4.1-flash`, provider prefix included. Same model, different literal — cite the wire string when quoting a run's evidence and the settings string when quoting the file.

Evidence: `docs/MANUAL_TESTING.md`, "The Pi smoke probe names the model that answered (OW-guvojo)". The stale sentence in the OW-moradi section's "What this leaves open" paragraph — the model "is still not in the evidence, which is what OW-guvojo is for" — was retired in the same change, narrowed to say the gap is closed for runs at `1c749a8` or later and not retroactively for the two runs that section reports.

The fork this card opened needed no filing: the card had already settled from the source that the server does expose the model, so the "exposes no model at all" branch never fired.

Commits on `main`: `1c749a8` (probe), `9b0bfc1` (evidence), `2ac491b` (sha correction plus the confirming run).
