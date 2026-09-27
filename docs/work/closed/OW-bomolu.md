---
labels: [defect, emacs]
closed: done
---

# A start error raised inside the attach Emacs makes on its own before a first prompt is cleared at that prompt's admission, before anyone could read it

Found by the adversarial read of OW-vulusi on 2026-09-25 and, independently, by OW-sedosu's read the next card over as OW-lokima, closed moot under this card; both traced by reading the code, neither by a live run.
Narrowed 2026-09-26, after OW-lohubo's adversarial read contradicted the card's first framing and a session read the code: the browser attaches before prompting too, so the difference between the clients is not whether they attach first but whether the attach is its own gesture.

## What the server rules, and what each client does

The prompt route in `src/server/http/app.ts` (the `"prompt"` case, "Read before the attach") reads `priorError` before the attach it may make, so an error the start raises is not one the sender saw and `SessionManager.submit` in `src/server/http/session-manager.ts` does not clear it at admission (OW-31, OW-bipume); since OW-lohubo that `submit` is the one place the rule runs, and it announces the clear as `error-cleared`.
That read protects only a prompt sent to a session nobody attached, a path no client takes today.

The browser attaches when a session is selected (`select` in `src/client/controller.ts` goes through `attachAndSelect`, which calls `api.attach`), so a start error reaches the tab as the attach's snapshot, the user reads it, and when they later prompt the route reads it as the prior and clears it at admission.
That is OW-31's rule doing its job: the error stood at send and the sender had seen it.

Emacs opens a stored session as a preview, which attaches nothing (the Commentary of `emacs/agentpane.el`, "Browsing spawns no agent subprocess"), and its first prompt attaches and prompts in one gesture: `agentpane--send-prompt` goes through `agentpane--attached-then`, which sends `sessions/attach` and then `sessions/prompt` on its reply, and the helper's handlers in `src/emacs/helper.ts` map those to `api.attach` and `api.prompt` separately.
So a start error the attach raises is drawn from the attach's snapshot and cleared by the admission's `error-cleared` inside the same round trip, and nobody read it.
A buffer told `session/detached` (OW-yibijo) takes the same path at its next prompt, and a new session does not, since `agentpane-new-session` attaches at creation.
The browser joins this path once OW-35 lands transparent attach-then-submit for a reaped session, which is why that card now names this one.

In service of `AGENTS.md`, "Both clients": a start error raised inside an attach a client made on the user's behalf, as part of sending, survives that prompt's admission the way it does for a prompt whose own attach raised it, and the server agrees with what each client draws.
Load-bearing: the error the server compares against at admission is the one that stood before the attach the send made, not after it.
Incidental: how that reaches the server — the prompt carrying the error its client held at send (since OW-lameke the server compares the error's id, not its text, so that means the id — see OW-jokoto), the helper reading `errorIdOf` before its own attach, the helper sending one request that attaches and prompts, or some other route — weighed against why `agentpane--attached-then` attaches first (its docstring, and OW-nasofa's single-send rule in `agentpane--send-prompt`).

## What OW-jokoto landed, noted 2026-09-26

OW-jokoto (1e005f6) put the error id on both wires and made a prompt carry `priorErrorId`, the id of the error its sender held at the send gesture, or `null` for none; a previewed Emacs buffer holds none, so its first prompt sends `null` and `SessionManager.submit` clears nothing at admission, whatever the attach raised.
Its ERT test `agentpane-test-prompt-names-no-error-its-own-attach-drew` shows the Emacs half, and the route test in `src/server/http/app.test.ts` for a `null` `priorErrorId` shows the server half; neither drives a start error through `FakeAdapterFactory({ onStart })`, which is what this card's done condition asks for.
So what remains here is that test, and a card that finds it green on first write should break OW-jokoto's `null` path in `submit` to see it red, since a test that has never failed has not been shown to test anything (`AGENTS.md`, "Evidence").

## Done when

A test drives a first prompt as Emacs sends it — a helper test in `src/emacs/helper.test.ts` against the fake server, or a server test in `src/server/http/app.test.ts` that attaches then prompts as the helper does — whose start raises an error, and shows the session's error still held and no `error-cleared` broadcast after admission, red before the change.
The existing prompt-route tests of OW-31 and OW-bipume still pass under `bun run check`, and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, passes if that file changes.

## Close note

The fix landed with OW-jokoto (1e005f6): a previewed Emacs buffer's first prompt carries `priorErrorId: null`, and `SessionManager.submit` clears nothing at admission for a null prior.
This card added the missing test, d86a244: "keeps an error the start of an attach raised before a first prompt whose sender held none (OW-bomolu)" in `src/server/http/app.test.ts`.
It drives the sequence `agentpane--attached-then` sends through the helper -- stream open, `GET` session (the helper's `sessions/attach` -> `api.attach`) whose `FakeAdapterFactory({ onStart })` start raises an error, then `POST` prompt with `priorErrorId: null` -- and shows no `error-cleared` on the watching stream (fenced by a notice) and the error still held, same id, in a fresh snapshot.
Red first: making a null `priorError` in `submit` fall back to `this.errorIdOf(session.ref)` fails it at the `error-cleared` assertion (and fails the OW-31 and OW-jokoto null-path neighbours too); reverted, green.
A server test rather than `src/emacs/helper.test.ts` because the helper tests run against a canned fetch and cannot see server state or the broadcast; the elisp half (reading `prior` before the attach) is already covered by the ERT test `agentpane-test-prompt-names-no-error-its-own-attach-drew`.
`bun run check`: svelte-check 0 errors, 1460 tests passed. `emacs/agentpane.el` unchanged, so the ERT suite was not rerun.
