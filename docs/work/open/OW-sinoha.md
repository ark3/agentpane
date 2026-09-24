---
labels: [defect]
---

# A fork inside a Pi process may put the spawn --model back over a model set_model chose

Read at the source of `pi 0.87.1` during OW-dojebo, and not run.

`fork` in Pi's `dist/core/agent-session-runtime.js` rebuilds the session through `createRuntime` in `dist/main.js`, which hands `createAgentSessionFromServices` the options parsed from the process's original command line, and `createAgentSession` in `dist/core/sdk.js` takes that `options.model` over the branch's model ("let model = options.model;").
OW-dojebo measured the level half of this live: a process spawned with `--model openrouter/deepseek/deepseek-v4.1-flash:high` and set to `off` ran the turn after a fork at `high` (`docs/MANUAL_TESTING.md`, "A Pi fork in a process spawned with a suffixed `--model` puts the suffix's level back, unrecorded (OW-dojebo)").
The model half was only read.

It is reachable from agentpane.
A fresh Pi session spawns with `--model <bound.model>` (`src/server/http/session-manager.ts`, beside "A resume carries no model, by D23"), D23's gate allows a model change before the first prompt, and that change goes to the live process as `set_model` (`case "model"` in `src/server/http/app.ts`, then `PiAdapter.setModel` in `src/server/adapters/pi/process.ts`).
So a session spawned on model A, switched to B before its first prompt, may run every turn after a fork on A, while its file's `model_change` and the assistant messages before the fork name B.
`PiAdapter.fork` reads the model back from `get_state`, so agentpane would show A after the fork; the harm is that the conversation silently changed model, against D23's "a conversation's model and effort are fixed after its first prompt".
It compounds OW-dojebo's fix: `fork` re-sends `chosenEffort`, which was checked against B's levels in `setModel`, not against A's.

In service of D23 in `docs/DESIGN.md`.
Load-bearing: whether `pi 0.87.1` or later, spawned with `--model A` and given `set_model` B, reports A or B from `get_state` after `fork`, which model the next turn's provider request names, and what the forked file records.
Incidental: the remedy, for instance the adapter remembering a chosen model and re-sending `set_model` after a fork as it re-sends the chosen level, in that order, since `set_model` resets the level (the `thinkingLevel` docblock in `process.ts`).
The D23 Pi bullet already says "Read at the source and not run, that fork also takes the spawn's `--model` over a model `set_model` chose"; this card retires or confirms that sentence.

## Done when

- A live run on the home server, with the throwaway `PI_CODING_AGENT_DIR` method and the `before_provider_request` extension recorded in OW-dojebo's section of `docs/MANUAL_TESTING.md`, spawned with `--model openrouter/deepseek/deepseek-v4.1-flash:high` and switched by `set_model` to another model the home server's Pi can reach, records with the version what `get_state`, the next turn's request, and the forked file show after a fork.
- If the model snaps back, a test in `src/server/adapters/pi/process.test.ts` forks a session after `setModel` and asserts the model and level in force after the fork are the chosen ones, shown red first; if it does not, the run's record is the whole of the work, and the D23 sentence quoted above is corrected in the same change.
