---
labels: [defect]
---

# agentpane_pi_smoke.py takes its model from the mutable settings file, not from the pin

`resources/probes/agentpane_pi_smoke.py` spawns Pi through the server without passing a model, so Pi resolves whatever `~/.pi/agent/settings.json` names at that moment.

`AGENTS.md` is explicit that this is not good enough: "Do not trust the machine's defaults to enforce it ... the flag is the whole of the constraint and is never optional".
It says so with a reason — on 2026-09-13 that same file was briefly unreadable and Pi resolved no model at all, answering `get_state` with `"id": "unknown"`, which is recorded in `docs/MANUAL_TESTING.md` under "Pi arrives on the home server, and what its settings file is worth there".

The probe gets away with it today only because the file happens to name the pinned model, and `docs/MANUAL_TESTING.md`'s "The Pi smoke probe runs on the home server, end to end through the built server" (OW-moradi) says so in as many words: the model for those runs "is knowable with confidence for them, by inference rather than from the blob".
OW-guvojo then taught the probe to read the model back off the SSE `snapshot`, which closes the *reporting* gap but not this one — reading back which model answered is not the same as having chosen it, and a settings file edited between two runs would silently change what the probe measures while still reporting honestly.

`resources/probes/agentpane_pi_steer_probe.py` is the worked example of the fix, filed 2026-09-14 under OW-yuyofu: it passes `--model` through the create-session route's `model` field, which reaches `buildPiSpawnCommand`'s `--model` (`src/server/adapters/pi/spawn.ts`), defaults that flag to the pinned ref, and still reads the answering model back off the wire.
Note the two spellings the write-ups have to keep straight: the settings file says `deepseek/deepseek-v4.1-flash` and the wire says `openrouter/deepseek/deepseek-v4.1-flash`, with the provider prefix.

Worth deciding while here, rather than assuming: whether `agentpane_codex_smoke.py` has the same shape against `~/.codex/config.toml`, which `AGENTS.md` names in the same breath as happening to select `gpt-5.6-luna`.

## Done when

`agentpane_pi_smoke.py` sends an explicit `--model`, defaulting to the ref `AGENTS.md` pins, and a run on the home server records that ref in its evidence blob as the flag it passed alongside the model it read back — so the two can be compared rather than one inferred from the other.
Say in `docs/MANUAL_TESTING.md` what the Codex harness turned out to do, whichever way that came out.
