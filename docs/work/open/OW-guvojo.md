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
The adapter already parses this: see `modelToInfo`/`splitModelRef` in `src/server/adapters/pi/protocol.ts` and whatever the session's REST representation exposes — prefer reading it back through the server the probe is already talking to over spawning a second `get_state` probe beside it.
If it turns out the server exposes no model for a Pi session at all, that is the answer: record it here and file what it exposes rather than adding a side channel to the probe.
