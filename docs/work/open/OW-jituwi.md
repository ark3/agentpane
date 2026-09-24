---
labels: [defect]
---

# An effort level the backend refuses still answers 500, where a refused model now answers 400

In service of the same contract OW-pizaki set for models: a value the backend refuses is a bad request, and the client should hear 400 with the backend's reason, not 500 `internal_error`.

OW-pizaki added `BackendRefusedError` in `src/server/adapters/types.ts`, mapped to `400 {"error":"backend_refused"}` in the catch of `createApp`'s `fetch` in `src/server/http/app.ts`, and thrown only from `setModel`.
Each adapter already tells a refusal from a failure by a private error class, so the effort path only needs the same conversion at its call site:

- Pi: `PiAdapter.setEffort` in `src/server/adapters/pi/process.ts` sends `set_thinking_level`; a `success: false` answer rejects as `PiCommandError`, which still reaches the route as a 500.
- Claude Code: `ClaudeAdapter.setEffort` in `src/server/adapters/claude/adapter.ts` sends `apply_flag_settings`; a `subtype: "error"` answer rejects as `ClaudeControlError`, likewise a 500.
- Codex: `CodexAdapter.setEffort` validates nothing and stores the string for the next `turn/start`, as its `setModel` does; that is the separate card on Codex models, not this one.

Also in `PiAdapter.setModel`: when `set_model` succeeds and the follow-up `set_thinking_level` (re-applying `chosenEffort`) is refused, the call rejects with a plain 500 after the model has already changed.
That branch only runs when `thinkingLevels(response.data)` lists the level, so whether Pi can refuse it there is unmeasured; decide whether it belongs here or is a guard nothing can trigger.

Load-bearing: a refusal becomes 400 and a dead or unanswering process stays 500 — OW-pizaki's death-guard tests in `pi/process.test.ts` and `claude/adapter.test.ts` show the pattern.

Done when `POST /api/sessions/<backend>/<id>/effort` with a level the Pi or Claude adapter's backend refuses answers 400 `backend_refused` with the backend's text, pinned by adapter tests and an `app.test.ts` route test seen red first, and the `BackendRefusedError` docblock no longer says "Thrown by `setModel` only".
