---
labels: [deferral]
---

# A Pi resume whose recorded model left the catalogue or lost its auth runs the settings default with no warning

Read at the source only, not run: `createAgentSession` in the installed Pi's `dist/core/sdk.js` (`pi 0.87.1`, under `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`), given no `--model` and a session with messages, restores the model the session context names only if `modelRuntime.getModel` finds it in the catalogue and its provider has auth.
Otherwise it sets `modelFallbackMessage` ("Could not restore model ...") and falls to `findInitialModel`, which reads the settings default.
Agentpane's Pi resume spawn deliberately carries no `--model`, per D23 in `docs/DESIGN.md`, because Pi restores the recorded model itself; `docs/MANUAL_TESTING.md`, "What model a Pi resume runs on (OW-pubulu)", measured that on the happy path and names this fallback under "Not established".
So in the fallback case the resumed conversation runs a model the user never chose, and agentpane shows it only as whatever `get_state` reports, with no word that the choice was lost.

This is in service of D23's promise that a conversation runs at the model it recorded, or says why not.
Load-bearing: whether Pi surfaces `modelFallbackMessage` anywhere over RPC (`get_state`, an event, stderr) that the adapter in `src/server/adapters/pi/process.ts` could relay through `onError`.
Incidental: how a client renders it.

Done when a run that resumes a session whose recorded model is absent from the throwaway catalogue (the `PI_CODING_AGENT_DIR` method in OW-pubulu's section) records in `docs/MANUAL_TESTING.md` what Pi emits, and either a server test shows the adapter relaying it, red first, or the section records that Pi emits nothing relayable.
