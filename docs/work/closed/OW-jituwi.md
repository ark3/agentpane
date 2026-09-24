---
labels: [defect]
closed: moot
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

## Close note

Moot: OW-tewofe landed five minutes after this card was filed. Since then neither the Pi nor the Claude Code adapter has a refusal left to convert.

- The route refuses first. `case "effort"` in `sessionAction` (`src/server/http/app.ts`) matches `getState().model` to `listModels()` and answers 400 `bad_request` for any effort that model does not list. It does this before calling `setEffort`, so only a listed level ever reaches an adapter.
- Pi never refuses `set_thinking_level`, as read at the source of `pi 0.87.1` (the version installed on the home server, 2026-09-24). In `dist/modes/rpc/rpc-mode.js`, `case "set_thinking_level"` calls `session.setThinkingLevel(command.level)` and always returns `success`. `AgentSession.setThinkingLevel` in `dist/core/agent-session.js` clamps a level the model lacks to one it has and throws nothing on that path. A `success: false` from Pi could only come from an unexpected exception, such as the session file write failing. That is a failure, not a refusal, so it rightly stays a 500.
- Claude Code never refuses `apply_flag_settings` either. As of `claude 2.1.280`, `effortLevel: "bogus"` answered success and changed nothing, and `low` on haiku also answered success (`docs/MANUAL_TESTING.md`, OW-hokaye).
- The card asked whether the `set_thinking_level` that `PiAdapter.setModel` re-sends for `chosenEffort` belongs here or guards nothing. It guards nothing. It only runs for a level the new model lists, and Pi 0.87.1 answers success even for a level a model does not list. So no conversion was added there.

Converting `PiCommandError` or `ClaudeControlError` to `BackendRefusedError` in `setEffort` would add a branch nothing can trigger, and it would suggest to later readers that these backends refuse effort levels. The `BackendRefusedError` docblock ("Thrown by `setModel` only") stays true. The `setEffort` contract in `src/server/adapters/types.ts` already says an adapter takes what it is given.

If a later Pi or Claude Code release starts refusing a listed effort, file a new card with the measured refusal as its evidence. Nothing changed in code.
