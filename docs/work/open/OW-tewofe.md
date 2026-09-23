---
labels: [deferral]
---

# An effort the model does not list is sent to every backend unchecked, and each answers POST .../effort with 204

OW-kokalo added `POST /api/sessions/:backend/:id/effort` (`case "effort"` in `sessionAction`, `src/server/http/app.ts`) and `sessions/setEffort` in the Emacs helper.
It validates only that `effort` is a string.

- `setEffort` in `src/server/adapters/codex/adapter.ts` stores any string and sends it on the next `turn/start`; what `codex-cli 0.156.0` does with an unlisted effort is unmeasured.
- `setEffort` in `src/server/adapters/claude/adapter.ts` has sent any string as `apply_flag_settings` since OW-hokaye, and reports what `get_settings` then applies.
  As of `claude 2.1.280`, an unknown level answers success and changes nothing, and on haiku, which lists no efforts, `low` answers success and applies null (`docs/MANUAL_TESTING.md` OW-hokaye), so this route answers 204 there, against the contract on `setEffort` in `src/server/adapters/types.ts` that a backend listing none refuses it.
- `setEffort` in `src/server/adapters/pi/process.ts` has sent any string as `set_thinking_level` since OW-ruzuhu.
  As of `pi 0.87.1`, Pi answers success and clamps: a level the model lacks moves to the nearest one it has (`medium` ran at `high` on the pinned model, `docs/MANUAL_TESTING.md` OW-ruzuhu), and a string that is no level at all goes to the model's first level, which is `off` on the pinned model -- read at pi-ai's `clampThinkingLevel`, not run.
  On a model that does not reason, whose `efforts` list is empty, it answers 204 as well, against the same contract.
  The adapter also keeps the unchecked string as its chosen effort and re-sends it after a later `setModel` to a model that lists it.

Each is a value the model does not list, silently accepted or taken as something else, the class OW-pizaki names for models.
Deferred because neither client can reach it: both offer only the efforts `GET /api/models` lists.

## Done when

- An HTTP test posts an effort the session's model does not list and asserts a 400, shown red first.
