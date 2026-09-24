---
labels: [deferral]
closed: done
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

## Close note

Built: `POST /api/sessions/:backend/:id/effort` (`case "effort"` in `src/server/http/app.ts`) now matches `getState().model` to `listModels()` by exact id, the rule both clients use to offer efforts (`selectedModelInfo` in `src/client/App.svelte`, `agentpane--read-effort` in `emacs/agentpane.el`), and answers 400 `bad_request` for an effort that entry does not list.
A model that lists no efforts, a null model, and a model the listing does not name all offer none and are refused the same way, before the adapter is called; one check covers Codex, Claude Code, Pi and the Emacs helper, which goes through the same route.
Adapters are unchanged and take what they are given; the `setEffort` contract in `src/server/adapters/types.ts`, `SetEffortRequest` in `src/shared/protocol.ts`, `sessions/setEffort` in `src/emacs/protocol.ts` and the `agentpane-new-session` docstring were reworded to say so.
It is a plain 400, not `BackendRefusedError`, since the backend is never asked.

Verified: the new test in `src/server/http/app.test.ts`, "refuses an effort the session's model does not list, before the adapter sees it (OW-tewofe)", covers no model, an unlisted effort and a model with no efforts; it failed against the unfixed route (expected 204 to be 400) and passes after; `bun run check` passed on main, 1261 tests.
The existing OW-kokalo effort test now sets a model first.

Cost: every effort POST makes one `listModels()` round trip to the backend.
Filed OW-zayefe for the window this opens in `agentpane-new-session`, which sends the effort without awaiting the model change.
