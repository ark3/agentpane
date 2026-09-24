---
labels: [defect]
closed: done
---

# A Pi fork at the first message of a resumed session may run at the settings default model and level

Read at the source of `pi 0.87.1` by the adversarial reader of OW-sinoha on 2026-09-24, and not run.

In service of D23 in `docs/DESIGN.md`, whose sentence "A fork that keeps no turn, one cut before the first message, has no stored turn to read back, and runs at the parent's model and effort as they stand when it is cut" binds every backend, and whose Pi bullet now reads "the chosen model and level on a fork".

A resumed Pi session spawns with no `--model` (`src/server/http/session-manager.ts`, beside "A resume carries no model, by D23"), so in that process `chosenModel` and `chosenEffort` on `PiAdapter` (`src/server/adapters/pi/process.ts`) are both null, and `fork` has nothing to re-assert.
Pi forks inside that process by rebuilding the session through `createAgentSession` in `dist/core/sdk.js` (under `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`), which restores the branch's model only when `buildSessionContext().messages.length > 0` ("If session has data, try to restore model from it") and otherwise takes `findInitialModel`, the settings default; the level likewise falls to the per-model setting or the global default.
A fork at the first user message keeps no messages, by the exclusivity OW-dojebo's section of `docs/MANUAL_TESTING.md` recorded ("Forking at the first user message kept the `model_change`, both `thinking_level_change` entries and the system message, and nothing else") — though whether that kept system message counts in `messages` is exactly what the source reading did not settle.
If it does not, the fork runs silently at the settings defaults, and `unrestoredModel` stays null because there is no assistant message to compare.
OW-sinoha's fix does not reach this case: it re-asserts only a model `setModel` chose in this process.

Load-bearing: what `get_state` names after a fork at the first user message in a process spawned `--session <file>` with no `--model`, when the throwaway `settings.json` defaults to a model and level other than the ones the file recorded.
Incidental: the remedy, for instance the adapter re-asserting the model and level in force just before the fork rather than only the chosen ones, which would cover this case and OW-sinoha's alike.

## The live run keeps every turn on the pinned model

Use the method in OW-dojebo's and OW-sinoha's sections of `docs/MANUAL_TESTING.md`: a throwaway `PI_CODING_AGENT_DIR`, the `before_provider_request` extension, a throwaway driver speaking to `pi --mode rpc`.
The recorded session runs its turns on the pinned `openrouter/deepseek/deepseek-v4.1-flash`; the throwaway `settings.json` defaults to some other model Pi can resolve.
If `get_state` after the fork names that other model, the turn after the fork is not sent, since it would run off the pin.

## Done when

- A live run on the home server, recorded with the version in `docs/MANUAL_TESTING.md`, shows what `get_state` names after that fork.
- If it names the settings default, a test in `src/server/adapters/pi/process.test.ts` forks a resumed session at its first user message and asserts the model and level in force after the fork are the parent's, shown red first, and the D23 Pi bullet is brought in line; if it names the recorded model and level, the run's record is the whole of the work.

## Close note

Done. The suspicion held for older session files.
Measured live on the home server, `pi 0.87.1`, recorded in `docs/MANUAL_TESTING.md` under "A Pi fork at the first message of a resumed session runs at the settings default when it keeps no message (OW-riyeku)".
A file written by `pi 0.86.0` or later keeps its system message at a fork at the first user message; Pi counts it (`messageCount` 1) and restores the recorded model and level itself.
A file with no system message, which every file written before 0.86.0 is (all nine of the owner's Pi sessions on the home server, by date), keeps nothing: `get_state` answered `messageCount` 0 at the settings default model and level, and Pi appended a `model_change` and `thinking_level_change` naming them.
Fix: `fork` in `src/server/adapters/pi/process.ts` notes the model and level in force before the fork, and when the fork's `get_state` answers `messageCount` 0 re-sends them through `setModel` and `set_thinking_level`; otherwise it re-sends only the chosen ones as before.
A test in `src/server/adapters/pi/process.test.ts` ("re-asserts the parent's model, then its level, after a resumed session's fork that keeps no message") was shown red first, and `bun run check` passed; the D23 Pi bullet and paragraph in `docs/DESIGN.md` and the `chosenModel`/`unrestoredModel` docblocks were brought in line.
The adapter's re-send was not run live; the same commands sent by hand in the run put the pinned model at `high` back.
Not covered: a 0.86.0+ file whose model or level changed mid-conversation, where the fork restores the opening values instead of the parent's current ones — filed as OW-bupuko.
