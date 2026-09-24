---
labels: [defect]
closed: done
---

# A model string with a thinking-level suffix answers 500, where the same string is valid on the spawn flag

`src/server/http/app.ts` -- the `model` case in `sessionAction` -- and whatever `setModel` reaches in `src/server/adapters/pi/`.

Observed live on the home server 2026-09-16 against `pi 0.85.1` (`docs/MANUAL_TESTING.md`, "`DELETE` then attach resumes a real Pi session, and the resumed spawn drops the model").
`POST /api/sessions/pi/<id>/model` with `{"model":"openrouter/deepseek/deepseek-v4.1-flash:high"}` answered HTTP 500 with `{"error":"internal_error","detail":"Model not found: openrouter/deepseek/deepseek-v4.1-flash:high"}`, and the server logged the same string.
The unsuffixed `openrouter/deepseek/deepseek-v4.1-flash` answered 204.

Two things are wrong and they may not have the same fix.
The status is wrong on its own terms: a model string the backend does not know is a bad request, so this is a 400 case surfacing as a 500 and telling the browser to treat a rejected value as a server fault.
And the two paths do not accept the same strings: Pi's spawn flag takes `provider/modelId:thinkingLevel` -- `AGENTS.md`'s own model pin is written in that form, and `src/server/adapters/pi/spawn.ts` passes it through to `--model` -- while `setModel` takes only `provider/modelId`.
So the exact string this project mandates for the pin is accepted at spawn and rejected after it, which is a trap for anyone re-asserting a model on a running session.

Load-bearing: that the same string succeeds on one path and 500s on the other.
Incidental: whether the repair is to parse the suffix in `setModel`, to reject it as a 400 with a message naming the accepted form, or both.
Worth deciding deliberately rather than by whichever is easier, because a silently *accepted* suffix that then does not change the thinking level would be worse than the 500.

Unmeasured, and worth checking before choosing: whether Codex and Claude Code have the same asymmetry, and what each answers to a model it does not know.

Done when a model string the backend rejects answers 400 with a message a user can act on, pinned by a server test -- red first -- and the accepted form is stated in one place both paths cite.

## What OW-ruzuhu decided about the suffix

Nothing changed in `setModel`: effort is its own field since OW-ruzuhu (`POST .../effort`, `set_thinking_level` in `src/server/adapters/pi/process.ts`), so `setModel` does not need to accept the suffix to set a level.
Stripping a trailing `:<level>` is not safe as a repair either: as of `pi 0.87.1` real catalogue ids contain colons, such as `openrouter/anthropic/claude-fable-5:batch`, so any parse has to match the suffix against the seven level names, not split on the last colon.
The measured precedence in OW-pubulu also bears on this card: on a resume spawn the suffix overrides the level the session file recorded.

## Close note

A model the backend refuses now answers 400 `{"error":"backend_refused","detail":<the backend's reason>}` instead of 500 `internal_error`; a backend that died or never answered still answers 500.
`BackendRefusedError` (`src/server/adapters/types.ts`) is mapped in the catch of `createApp`'s `fetch` in `src/server/http/app.ts`.
Pi's and Claude Code's `setModel` convert only the backend's own refusal into it (private `PiCommandError` for a `success: false` response, `ClaudeControlError` for a control `subtype: "error"`); an exit, a failed write, or a closed pipe stays a plain Error.

The suffix: nothing strips or parses it.
The string goes to Pi's `set_model` unchanged, and only when Pi refuses one ending in `:<one of THINKING_LEVELS>` does the message add that a model here is "provider/modelId" and the level is set as the effort.
Real catalogue ids contain colons (`openrouter/anthropic/claude-fable-5:batch`, `pi 0.87.1`), which is why this is a hint on refusal and not a parse.
A Pi model string with no slash is refused as 400 without being sent, since `set_model` cannot carry it.
The accepted forms are stated once, under "Model refs" in `src/server/adapters/pi/protocol.ts`, and cited by `PiSpawnOptions.model` in `spawn.ts` and by `PiAdapter.setModel`: `set_model` takes `provider/modelId` only (read in `rpc-mode.js`, `pi 0.87.1`), `--model` also takes an optional `:<thinking>` (Pi's help text, `pi 0.87.1`).

Verified: route test in `app.test.ts` (400 on refusal, 500 on plain failure) went red with `expected 500 to be 400` without the mapping; adapter tests in `pi/process.test.ts` and `claude/adapter.test.ts` went red before the conversion; death-guard tests for both were shown able to fail by temporarily converting every Error. `bun run check` green, 1260 tests.

Not done here, filed: OW-jituwi (effort refusals still 500), OW-wawuzu (Codex takes any model string with 204).
