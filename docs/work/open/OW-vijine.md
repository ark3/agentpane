---
labels: [unverified]
---

# Pi's fork, resume and model-restore behaviour was last measured on 0.87.1, and agentpane's fork and hydrate code rests on it under pi 1.2.0

Filed 2026-10-14, when the home server's and the work laptop's `pi` both reported `1.2.0`, ten releases and a `1.0.0` past the `0.87.1` these facts were measured on.
D18 in `docs/DESIGN.md` re-verifies nothing on a bump by policy; the owner chose on 2026-10-14 to re-measure this set once, because the jump is large and each fact below is one agentpane's code was built on.
This is that one re-measure, not a new rule.

The facts, each with the `docs/MANUAL_TESTING.md` section that measured it:

1. A Pi fork during a streaming turn succeeds, stops the turn, and keeps the text already streamed into the parent's file: "Pi's mid-stream fork, measured against text known to have streamed (OW-sededi)" and "Pi's mid-stream fork, and the forked file on disk, re-measured at the instrument (OW-gajesu)", on `0.85.1`; `resources/probes/fork_probe.py` is the vehicle.
2. The abandoned turn's last events, `agent_settled` among them, all arrive before the `fork` response, and nothing arrives between it and the `get_messages` answer after it: "What each backend says while a live session's history is read back (OW-dutute)", on `0.87.1`; `resources/probes/hydrate_window_probe.py --backend pi` is the vehicle.
   This is the one the code leans on hardest: it is why `hydrateMessages` in `src/server/adapters/pi/process.ts` may replace the transcript, so if it has moved, live content can be dropped silently.
3. A fork puts the spawn's `--model` back over a model `set_model` chose, without recording it: "A Pi fork puts the spawn's `--model` back over a model `set_model` chose, unrecorded (OW-sinoha)".
4. A fork in a process spawned with a suffixed `--model` puts the suffix's level back, unrecorded: "A Pi fork in a process spawned with a suffixed `--model` puts the suffix's level back, unrecorded (OW-dojebo)".
5. A fork at the first message of a resumed session runs at the settings default when it keeps no message: "A Pi fork at the first message of a resumed session runs at the settings default when it keeps no message (OW-riyeku)".
   That section left open whether the system message such a fork keeps counts as a message; Pi's `role: "system"` messages (OW-wavini) make that question live, so this run answers it.
6. A resume that clamps the recorded level, or is given an override, records no level: "A Pi resume that clamps the recorded level, or overrides it, records no level (OW-lehita)".

Facts 3 to 6 were run ad hoc on 2026-09-24 under a throwaway `PI_CODING_AGENT_DIR`, as each section's opening paragraph describes, rather than through a committed probe; reproduce each run as its section describes.
OW-bupuko, open, is a defect resting on fact 5's neighbourhood under `0.86.0`+; this run's result for a first-message fork goes into that card as an amendment, whatever it shows.
OW-tigaye's runs overlap fact 1's vehicle; if both are worked in one session, one run may serve both.

In service of agentpane's fork, resume and hydrate code resting on facts true of the Pi that runs today.
Load-bearing: the version on every result, the pinned model (`pi --model openrouter/deepseek/deepseek-v4.1-flash:high`, AGENTS.md "Evidence"), and that the owner's `~/.pi/agent/settings.json` is never written — every run uses a throwaway `PI_CODING_AGENT_DIR`, as the sections above did.

## Done when

Each of the six facts has a dated entry in `docs/MANUAL_TESTING.md` naming `1.2.0` (or whatever `pi --version` then reports) and saying whether it held.
Every copy of a fact that moved is retired in the same change, wherever it stands — `AGENTS.md`'s Pi fork bullet under "Evidence", the `process.ts` and `reducer.ts` docblocks, `docs/DESIGN.md` — per AGENTS.md's "retires every copy" rule; a fact that held gets its version added where the copy names one.
Every fact that moved and leaves agentpane's code wrong gets a `defect` card, or an amendment to the open card that already owns it.
