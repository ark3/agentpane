---
labels: [deferral]
---

# Two overlapping Pi setModel calls can still broadcast a model paired with a level it was never at

OW-sewewe, filed 2026-09-24 under D24, closes this: its manager-level ordering test is the fix at the route this card's incidental line allows, and a second guard in the adapter is not to be written for it.

Found by the adversarial read of OW-zasozo, reproduced over a fake child and not run against a live Pi.

OW-zasozo made `PiAdapter` in `src/server/adapters/pi/process.ts` hold a `thinking_level_changed` while `set_model` is in flight, behind the boolean `settingModel`, so no status pairs the old model with the level `set_model` resets to.
The hold is one flag for any number of calls.
When call A's response clears it while call B is still in flight, B's reset event is synced at once against `this.model`, which A just set.
The reader's probe switched FLASH to Fable (A) overlapping Fable to FLASH (B), with B's reset to `off` arriving after A's answer, and it emitted Fable at `off`, a level Fable does not offer.
A counter in place of the boolean is not enough on its own: A's early `syncEffort()` after its response would still pair A's model with a level B's event already recorded.

Nothing serialises the calls on the server.
The route in `src/server/http/app.ts` that answers a set-model request calls `adapter.setModel` directly.
The browser cannot overlap two, because `setModel` in `src/client/controller.ts` returns early while `modelSettingForSession` says one is pending.
Emacs can: `agentpane-set-model` in `emacs/agentpane.el` sends `sessions/setModel` with no in-flight guard, and the docblock of `agentpane--check-gate` says "neither the server nor the helper does" enforce the gate.
Two clients on one session can also overlap them.
OW-zayefe is the neighbouring race, an effort sent without awaiting the model.

Deferred because both clients allow a model change only before the first prompt, and the wrong pairing lasts until the last call's response settles the status.

Load-bearing: no status pairs a model with a level that model was never at, however many `setModel` calls overlap.
Incidental: whether the fix serialises `setModel` in the adapter, at the route, or in the Emacs client.

## Done when

- A test in `src/server/adapters/pi/process.test.ts` overlaps two `setModel` calls whose reset events interleave with the responses, records every update, and asserts that none pairs a model with a level other than the one it was at, shown red first.
