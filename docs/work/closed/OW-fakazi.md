---
labels: [change]
closed: done
---

# A prompt the backend handled without starting a turn clears the session's held error, which the owner decided it must keep

Filed 2026-10-15 from the owner's decision on OW-webiwu.
In service of the held error (OW-31, OW-bipume, OW-jokoto) meaning how the session's last turn ended, and going away only when something replaced it or the user dismissed it.

## What happens

`SessionManager.submit` in `src/server/http/session-manager.ts` clears the session's held error once `adapter.submit` resolves, whenever the sender's `priorError` still names it, and broadcasts `error-cleared` through `this.broadcaster.errorCleared(session)`.
It ignores the `PromptDisposition` that `adapter.submit` resolved with.
A Pi prompt an extension command consumed resolves `"handled"` (`PiAdapter.submit` in `src/server/adapters/pi/process.ts`), started no turn, and so replaced nothing, yet the error goes.
On `pi 1.2.0`, `/refs`, `/llama` and `/mcp` answered `handled` and no event followed (`docs/MANUAL_TESTING.md`, "A prompt an extension command handles").
So an attach that fails with an MCP extension error, followed by `/mcp` to look into it, wipes the failure that explained it, and nothing brings it back.

## The decision

`docs/DESIGN.md` D3, the paragraph after the bullet list that opens "A prompt the backend consumed without starting a turn for it", records it: a handled prompt keeps the held error, full stop.
The accepted cost is that an extension command which starts a turn of its own, like the `/ask` in Pi's `examples/extensions/send-user-message.ts`, leaves the failure standing over that turn until the user dismisses it.
Do not tie the clear to a turn's start or defer it to the next one: D3's paragraph says why those were declined.

## What to change

Only a started disposition clears, in `SessionManager.submit`; the `priorError` comparison and the closed-container return stay as they are.
Rewrite the comment above the clear, which today calls admission "the one place that rule runs", so it says a handled prompt keeps the error and points at D3.
Then the D3 paragraph's last sentence, which says the server still clears at a handled prompt's admission until this card lands, is retired in the same change, and so is the D3 bullet's "at a prompt's admission", which becomes the admission of a prompt that started a turn.
The `PromptDisposition` docblock in `src/shared/protocol.ts` gains one sentence saying a handled prompt leaves the held error standing.
No client logic changes: `src/client/session-state.ts` drops the error only on `error-cleared`, and `src/emacs/helper.ts` forwards that as `session/errorCleared`; the comments in `src/client/controller.ts` `submit` and `agentpane--error` in `emacs/agentpane.el` say the server clears when admitting the prompt, which stays true of a started one.

## Done when

A test in `src/server/http/app.test.ts`, in the describe "what a client that connects late is told (OW-bipume)", raises an error with its `raise` helper, posts a prompt the fake answers `"handled"` with `priorErrorId` naming that error, and asserts that no `error-cleared` went out and that a client connecting afterwards opens on a snapshot still carrying the error.
`FakeAdapterFactory({ onSubmit: ... })` in `src/server/http/testing/fakes.ts` already lets a fake answer `"handled"`; the OW-dulipe test "answers a prompt the backend handled without a turn 200 with a body" in the same file shows how.
That test fails against today's `SessionManager.submit` and passes after the change.
The existing test "clears at admission the error the prompt names as the one its sender held (OW-jokoto)" still passes, showing a started prompt still clears.
`bun run check` passes.

## Close note

`SessionManager.submit` (src/server/http/session-manager.ts) now clears the held error only when `adapter.submit` resolves `"started"`; a `"handled"` prompt keeps it, per D3 (decided in OW-webiwu). The `priorError` comparison and the closed-container return are unchanged.
"Started" also covers a steer that joined a running turn (D16), and a steer still clears as before, so the rewritten comments, D3's `error-cleared` bullet and the wire docs say "a prompt that started or joined a turn". D3's paragraph says a steer starts no turn, so the card's suggested wording, "started a turn", would have contradicted it.
Every copy of the old "any admitted prompt clears" claim was retired: D3's bullet and the "Until OW-fakazi lands" sentence, the comment and docblock at `SessionManager.submit`, the `error-cleared` and `PromptRequest.priorErrorId` docblocks and the `PromptDisposition` docblock in src/shared/protocol.ts, the `session/errorCleared` entry in src/emacs/protocol.ts, and the header commentary in emacs/agentpane.el. There were no client logic changes.
Verified by a new test in src/server/http/app.test.ts, in the OW-bipume describe: "keeps the error a prompt names when the backend handled it without a turn (OW-fakazi)". With the disposition guard reverted it fails (`expected [ { type: 'error-cleared', … } ] to deeply equal []`) while the three OW-jokoto tests pass, and with the guard in place it passes. `bun run check` passed: 59 files, 1679 tests.
