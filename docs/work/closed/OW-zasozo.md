---
labels: [deferral]
closed: done
---

# A Pi model change broadcasts a status pairing the old model with the new model's thinking level

Found by OW-ruzuhu's adversarial read over a fake child, and not run against a live Pi.

As of `pi 0.87.1`, `set_model` announces the level it resets to with a `thinking_level_changed` event *before* the command's own response (`docs/MANUAL_TESTING.md`, "A Pi turn at a chosen thinking level, what `set_model` does to it, and what a resume keeps (OW-ruzuhu)").
`PiAdapter` in `src/server/adapters/pi/process.ts` handles that event where `handleLine` meets it, calling `syncEffort()` and `emitUpdate()` at once.
`this.model` and `this.reasoning` still describe the old model at that point, because `setModel` only updates them once the response arrives.
So one status goes out as `{ model: <old>, effort: <new model's level> }`.
Going from a reasoning model to one that does not reason, that status reads the old model at `off`.
The probe emitted `["p/a","low"]` and then `["p/b","medium"]`.

The final status is always right, and when `setModel` re-sends a chosen level that fixes it too.
Deferred because the wrong pairing lasts one status: at worst the browser's effort select, which is keyed on model and effort together, re-renders twice.

Load-bearing: no status pairs a model with a level that model was never at.
Incidental: whether the fix holds the event's update until `set_model` answers, or reads the model from the event's context.

## Done when

- A test in `src/server/adapters/pi/process.test.ts` records every update across a `setModel` whose reset event arrives before the response, and asserts that none pairs the old model with the new level, shown red first.

## Close note

Landed on main in two commits, "fix: hold Pi's level reset until set_model names the new model (OW-zasozo)" and "fix: report a level held across a failed set_model (OW-zasozo)".
`PiAdapter` in `src/server/adapters/pi/process.ts` now holds a `thinking_level_changed` behind a `settingModel` flag while `set_model` is in flight: the level is recorded but not synced into the reported effort, so every update in that window still pairs the old model with its own level.
The response syncs it as soon as it names the new model, before any re-send of a chosen level, so the re-send window reports the new model at its reset level rather than a stale one.
On failure the catch syncs whatever level arrived meanwhile, and `.finally` clears the flag.

Verified in `src/server/adapters/pi/process.test.ts` by four tests, each shown red with its piece removed: "never pairs the old model with the level set_model resets to" (red on the unfixed code with three `[flash, "medium"]` updates, from the reset event, `agent_start` and `message_start`), "reports the new model's level while the chosen one is re-sent" (red without the early sync, reporting `[fable, "max"]`), "reports a level that changed while a refused set_model was in flight" and "follows Pi's level again after it refuses a set_model".
`bun run check` passed on main, 1265 tests.

The adversarial read found that two overlapping `setModel` calls still break the invariant, because one boolean covers them all; filed as OW-woyifu.
It also noted that a turn whose `message_start` lands inside the window is now stamped with the old level, where Pi may already have switched; no client can start a turn then, since both allow a model change only before the first prompt, so it was not filed.
