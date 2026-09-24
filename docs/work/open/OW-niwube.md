---
labels: [deferral]
---

# A loaded Pi turn recorded at a level its model has since dropped is labelled with the level that clamps to

OW-lehita made `withLoadedEfforts` in `src/server/adapters/pi/reducer.ts` clamp each recorded `thinking_level_change` level to the turn's model from today's `get_available_models` catalogue, fetched in `hydrateMessages()` in `src/server/adapters/pi/process.ts`, using the transcription `clampThinkingLevel` in `src/server/adapters/pi/protocol.ts`.
That recovers the level a resume put in force by clamping without recording it, but it assumes the model's catalogue entry is the one the turn ran under.

It is not always.
`docs/MANUAL_TESTING.md` records the pinned `openrouter/deepseek/deepseek-v4.1-flash` mapping `off`, `high` and `xhigh` on 2026-09-13 under `pi 0.85.1` ("Pi arrives on the home server"), and `off`, `low`, `high` and `max` on 2026-09-23 under `pi 0.87.1` (OW-ruzuhu's section).
So a turn that ran at `xhigh` under 0.85.1, which the code before OW-lehita labelled `xhigh`, now reloads labelled `max`; a model whose `reasoning` flag flips would lose its label the same way.
The `withLoadedEfforts` docblock and the OW-lehita section of `docs/MANUAL_TESTING.md` ("What agentpane makes of it") state the limit.
As of 2026-09-24 no session under the home server's `~/.pi/agent/sessions` was affected: all its assistant turns were on the pinned model at `high` or `off`, which both catalogues carry.

Two narrower cases the clamp also gets wrong, read at the source of `pi 0.87.1` by OW-lehita's adversarial reader and not run:

- A resume that clamps without recording, followed by `set_model` to a model that supports the unclamped recorded level: `setThinkingLevel` in `dist/core/agent-session.js` appends only on a change, so nothing is recorded, and the clamp names the recorded level where the clamped one ran (`_getThinkingLevelForModelSwitch`).
- `_refreshCurrentModelFromRegistry` in `dist/core/agent-session.js`, reached from an extension's `registerProvider` and kin, swaps the model object without re-clamping.

Deferred because the fix has no clean source: the file records no catalogue, and the clamp cannot tell a resume boundary from a turn that ran under an older catalogue.
What it is in service of is D23 in `docs/DESIGN.md`, read per turn.
Load-bearing: that a turn's label is the level it ran at; incidental: how that is recovered, for instance agentpane appending nothing and instead keeping its own record of the level `get_state` reported at each resume.

## Done when

- A test in `src/server/adapters/pi/process.test.ts` reloads a turn recorded at a level its model's current catalogue entry lacks, where that level was in force when it ran, and asserts it keeps the recorded level, shown red first against the code OW-lehita landed; and the OW-lehita test, where the clamp is right, still passes.
