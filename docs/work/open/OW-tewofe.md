---
labels: [deferral]
---

# An effort the model does not list is sent to Codex and Pi unchecked, and Claude Code answers POST .../effort with 500

OW-kokalo added `POST /api/sessions/:backend/:id/effort` (`case "effort"` in `sessionAction`, `src/server/http/app.ts`) and `sessions/setEffort` in the Emacs helper.
It validates only that `effort` is a string.

- `setEffort` in `src/server/adapters/codex/adapter.ts` stores any string and sends it on the next `turn/start`; what `codex-cli 0.156.0` does with an unlisted effort is unmeasured.
- `setEffort` in `src/server/adapters/claude/adapter.ts` throws a plain `Error`, which the route surfaces as a 500.
- `setEffort` in `src/server/adapters/pi/process.ts` has sent any string as `set_thinking_level` since OW-ruzuhu.
  As of `pi 0.87.1`, Pi answers success and clamps: a level the model lacks moves to the nearest one it has (`medium` ran at `high` on the pinned model, `docs/MANUAL_TESTING.md` OW-ruzuhu), and a string that is no level at all goes to the model's first level, which is `off` on the pinned model -- read at pi-ai's `clampThinkingLevel`, not run.
  On a model that does not reason, whose `efforts` list is empty, it answers 204 as well, against the contract on `setEffort` in `src/server/adapters/types.ts` that a backend listing none refuses it.
  The adapter also keeps the unchecked string as its chosen effort and re-sends it after a later `setModel` to a model that lists it.

Each is a value the model does not list, either surfacing as a server fault or silently accepted as something else, the class OW-pizaki names for models.
Deferred because neither client can reach it: both offer only the efforts `GET /api/models` lists, and that list is empty for Claude Code until OW-hokaye lands, which replaces its throw anyway.

## Done when

- An HTTP test posts an effort the session's model does not list and asserts a 400, shown red first.
