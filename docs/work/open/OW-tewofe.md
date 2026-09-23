---
labels: [deferral]
---

# An effort the model does not list is sent to Codex unchecked, and Pi and Claude Code answer POST .../effort with 500

OW-kokalo added `POST /api/sessions/:backend/:id/effort` (`case "effort"` in `sessionAction`, `src/server/http/app.ts`) and `sessions/setEffort` in the Emacs helper.
It validates only that `effort` is a string.

- `setEffort` in `src/server/adapters/codex/adapter.ts` stores any string and sends it on the next `turn/start`; what `codex-cli 0.156.0` does with an unlisted effort is unmeasured.
- `setEffort` in `src/server/adapters/pi/process.ts` and `src/server/adapters/claude/adapter.ts` throws a plain `Error`, which the route surfaces as a 500.

Both are a rejected value surfacing as a server fault, the class OW-pizaki names for models.
Deferred because neither client can reach it: both offer only the efforts `GET /api/models` lists, and that list is empty for Pi and Claude Code until OW-ruzuhu and OW-hokaye land, which replace those two throws anyway.

## Done when

- An HTTP test posts an effort the session's model does not list and asserts a 400, shown red first.
