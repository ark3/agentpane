---
labels: [defect]
---

# A Pi fork at the first message of a 0.86.0+ session may restore the early model, not the parent's current one

Read at the code on 2026-09-24 by the implementer of OW-riyeku, on `pi 0.87.1`, and not run.

In service of D23 in `docs/DESIGN.md`, whose sentence "A fork that keeps no turn, one cut before the first message, has no stored turn to read back, and runs at the parent's model and effort as they stand when it is cut" binds every backend.

OW-riyeku's section of `docs/MANUAL_TESTING.md` ("A Pi fork at the first message of a resumed session runs at the settings default when it keeps no message") measured that a session file written by `pi 0.86.0` or later keeps its system message at a fork at the first user message, so `get_state` answers `messageCount` 1 and Pi restores the model and level from the kept branch itself.
The kept branch holds only the entries ahead of the first user message: the `model_change` and `thinking_level_change` the session opened with.
So where the model or level was changed later in the conversation and the session was then resumed, the parent runs at the later model, but by the source reading in that section the fork restores the opening one.

`fork` in `src/server/adapters/pi/process.ts` re-sends the parent's model and level in force before the fork only when the fork's `get_state` answers `messageCount` 0 (the `keptNoMessage` branch, beside "A fork that keeps no message has nothing for Pi to restore from"), and otherwise only `chosenModel` and `chosenEffort`, which a resume spawn leaves null.
So this case would run the fork at the opening model and level, silently, and `unrestoredModel` stays null because there is no assistant message to compare.

Load-bearing: what `get_state` names after a fork at the first user message, in a process spawned `--session <file>` with no `--model`, of a 0.86.0+ file whose model and level were changed by `set_model` and `set_thinking_level` after the first turn.
Incidental: the remedy — for instance, keying the re-send of the parent's model and level on the fork keeping no turn (no user message), which is D23's own condition, rather than on `messageCount` 0.

## The live run keeps every turn on the pinned model

Use the method in OW-riyeku's section of `docs/MANUAL_TESTING.md`: a throwaway `PI_CODING_AGENT_DIR` under `/var/tmp`, a `before_provider_request` extension logging each request's `model` and `reasoning`, a throwaway driver speaking to `pi --mode rpc`.
Every turn sent runs on `openrouter/deepseek/deepseek-v4.1-flash`.
Create the session on that model at one level and run a turn, then change the level with `set_thinking_level` and run another, so the level case is covered on the pin.
For the model case, after a turn on the pinned model, `set_model` to some other model Pi can resolve and send no turn on it: the parent's current model is then that other one, and a fork that restores the opening model lands back on the pin.
If `get_state` after the fork names a model other than the pinned one, the turn after the fork is not sent.

## Done when

- A live run on the home server, recorded with the version in `docs/MANUAL_TESTING.md`, shows what `get_state` names after that fork.
- If it names the opening model or level rather than the parent's current one, a test in `src/server/adapters/pi/process.test.ts` forks a resumed session at its first user message with `get_state` answering `messageCount` 1 at the opening model and level, and asserts the model and level after the fork are the parent's, shown red first; the fix lands, and the D23 Pi bullet in `docs/DESIGN.md` is brought in line.
  If it names the parent's current model and level, the run's record is the whole of the work.
