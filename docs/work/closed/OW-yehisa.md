---
labels: [defect, sweep-0929]
closed: done
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

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) found the same defect in `resources/probes/capture_fixtures.py`: it starts Pi as `pi --mode rpc --no-session` with no `--model`, while its Codex path is pinned.
Fix both here.
OW-sofige's live runs and OW-zadupu's capture pass are meant to run after this lands.

Done also requires `capture_fixtures.py` to pass Pi an explicit `--model` defaulting to the pinned ref, with the ref recorded in the capture's metadata beside the model the capture read back.

## Amended 2026-09-29, at OW-letevu's close

OW-letevu removed the `request` SSE events the probe's dialog window observed, and rewrote that observation without a live run: `requests_in` became `dialogs_in`, which counts `error` events whose message begins "Pi sent a dialog agentpane cannot answer", and the evidence key `agent_requests_seen` became `agent_dialogs_cancelled` (`resources/probes/agentpane_pi_smoke.py`, the `DIALOG_CANCELLED` constant and the `if args.tool_check:` block).
The home-server run this card already requires is therefore the probe's first since that change.
Done also requires that run to complete with `agent_dialogs_cancelled` in its blob, `docs/MANUAL_TESTING.md` to say in that run's entry that the key and what it counts changed under OW-letevu, and the probe's "Verified with" line in `resources/probes/README.md` to name that run.

## Close note

Landed on main as 0c6bd70..387d9bc plus review fixes d01e6b7.
agentpane_pi_smoke.py now creates its session with "model": openrouter/deepseek/deepseek-v4.1-flash:high (--model, default the AGENTS.md pin), and records model_flag and checks.model.flag_passed beside the model and effort read back.
Home-server runs 2026-09-30 on pi 0.87.1, bare and --tool-check, both passed with agent_dialogs_cancelled present (no dialogs fired) and checks.model reading openrouter/deepseek/deepseek-v4.1-flash at effort high.
The probe could not pass at all since OW-mofuho retired the renamed event; it now waits for a snapshot under the attach reply's handle.
agentpane_codex_smoke.py had the same defect (codexCommand spawns a bare app-server and CodexAdapter.start sends model only if the session was created with one), so it now posts gpt-5.6-luna and reads the thread's model back; passed on codex-cli 0.157.1.
capture_fixtures.py spawns Pi with --model (--pi-model, default the pin) and records model_flag beside models_seen in the .meta.json; compiled, not run live.
On this machine the read-back cannot tell flag from settings file, since both resolve to the pin; docs/MANUAL_TESTING.md, "The Pi smoke probe passes the pinned model, and runs again since OW-letevu (OW-yehisa)", records that, the OW-letevu key change, and the Codex finding.
Review filed OW-niwusi (probes still keyed by ref and on renamed; the steer probe hangs) and OW-yezeya (fork_probe.py and pi_rpc_probe.sh unpinned).
