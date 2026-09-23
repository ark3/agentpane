---
labels: [deferral]
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
