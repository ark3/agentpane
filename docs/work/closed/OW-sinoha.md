---
labels: [defect]
closed: done
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
Since OW-jitoni, `PiAdapter.fork` also compares the kept branch's recorded model with `get_state`'s, so this snap-back now surfaces as `unrestoredModel` naming B on both wires (the docblock on that field in `process.ts` names this case).
A remedy that re-asserts B after the fork has to leave `unrestoredModel` null once B is back in force; `setModel` clears it, but a bare `set_model` command sent past it would not.

In service of D23 in `docs/DESIGN.md`.
Load-bearing: whether `pi 0.87.1` or later, spawned with `--model A` and given `set_model` B, reports A or B from `get_state` after `fork`, and what the forked file records.
Incidental: the remedy, for instance the adapter remembering a chosen model and re-sending `set_model` after a fork as it re-sends the chosen level, in that order, since `set_model` resets the level (the `thinkingLevel` docblock in `process.ts`).
The D23 Pi bullet already says "Read at the source and not run, that fork also takes the spawn's `--model` over a model `set_model` chose"; this card retires or confirms that sentence.

## The live run keeps every turn on the pinned model

Set by the owner on 2026-09-24.
The `AGENTS.md` pin binds every turn here, so the run reverses the roles above: spawn with `--model` naming some other model the home server's Pi can resolve, and never run a turn on it; `set_model` to the pinned `openrouter/deepseek/deepseek-v4.1-flash`, run the turns before the fork there, fork, then read `get_state` and the forked file.
If `get_state` names the spawn model after the fork, the snap-back is shown, and the turn after the fork is not sent, since it would run off the pin.
If it names the pinned model, a turn after the fork runs on the pinned model and may be sent, with its provider request read through the `before_provider_request` extension as OW-dojebo's run did.

## Done when

- A live run on the home server, with the throwaway `PI_CODING_AGENT_DIR` method and the `before_provider_request` extension recorded in OW-dojebo's section of `docs/MANUAL_TESTING.md`, arranged as the section above says, records with the version what `get_state` and the forked file show after a fork, and the next turn's request only where that turn was sent.
- If the model snaps back, a test in `src/server/adapters/pi/process.test.ts` forks a session after `setModel` and asserts the model and level in force after the fork are the chosen ones, shown red first; if it does not, the run's record is the whole of the work, and the D23 sentence quoted above is corrected in the same change.

## Close note

Confirmed live on the home server, 2026-09-24, `pi 0.87.1`: a Pi process spawned with `--model openrouter/google/gemini-2.5-flash-lite` and moved by `set_model` to the pinned `openrouter/deepseek/deepseek-v4.1-flash` answered `get_state` after a `fork` with the spawn's model, announced by no event, while the forked file's last `model_change` still named the chosen one and a bare resume of that file read the chosen model.
The chosen level (`low`) survived; only a `--model` suffix brings the level back (OW-dojebo).
The turn after the snapped-back fork was not sent, to keep every turn on the pin; a second run sent `set_model` then `set_thinking_level` by hand and the next turn's provider request asked for the pinned model at the chosen level.
Recorded in `docs/MANUAL_TESTING.md`, "A Pi fork puts the spawn's `--model` back over a model `set_model` chose, unrecorded (OW-sinoha)"; the D23 Pi bullet in `docs/DESIGN.md` now states it as measured.

Fix: `PiAdapter` remembers `chosenModel` in `setModel`, and `fork` re-sends it through `setModel` (model first, then the level, since `set_model` resets it) when `get_state` names another model; a refused re-send falls through so a fork Pi already made does not fail, and `unrestoredModel` then names the chosen model.
Two tests in `src/server/adapters/pi/process.test.ts`, each shown red first: the re-assert, and the refusal case the adversarial read found as a regression in the first cut.
Filed from that read: OW-riyeku, a fork at the first message of a resumed session, which has nothing chosen to re-assert.
