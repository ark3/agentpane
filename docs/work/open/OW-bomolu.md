---
labels: [defect, emacs]
---

# The server clears an error an Emacs session's start raised, because the Emacs client attaches before it prompts

Found by the adversarial read of OW-vulusi on 2026-09-25, traced by reading the code, not by a live run.

The prompt route in `src/server/http/app.ts` (the `"prompt"` case, "Read before the attach") reads `priorError = sessions.errorOf(ref)` before `sessions.attach(ref)`, so that an error the session's start raises is not one the sender saw, and `SessionManager.submit` in `src/server/http/session-manager.ts` does not clear it at admission (OW-31, OW-bipume).
The Emacs client defeats that ordering: `agentpane--send-prompt` in `emacs/agentpane.el` goes through `agentpane--attached-then`, which sends `sessions/attach` first and `sessions/prompt` only after it answers, and the helper's `"sessions/attach"` and `"sessions/prompt"` handlers in `src/emacs/helper.ts` map those to `api.attach` and `api.prompt` separately.
By the time the prompt route runs, the session has already started, so an error its start raised (`adapter.onError` in `SessionManager`'s `#start` sets it, and the attach's snapshot carries it to Emacs) is read as `priorError` and cleared at admission.
Emacs, since OW-vulusi, drops only the errors drawn when the prompt was sent, and a previewed buffer draws none, so Emacs keeps the start error drawn while the server holds null; the next snapshot, from `g` or the next turn boundary, makes it vanish unexplained.

In service of `AGENTS.md`, "Both clients": a start error survives the admission of the prompt that started the session in both clients, and the server agrees with what each one draws.
Load-bearing: the error the server compares against at admission is the one that stood before this client's attach, not after it.
Incidental: how that reaches the server — the prompt carrying the error its client saw at send, the helper reading it before its own attach, or some other route.

Amended 2026-09-26: OW-lokima, filed by OW-sedosu's adversarial read on 2026-09-25, found this defect independently and closed moot under this card.
Its trace adds two things: the browser POSTs a first prompt without attaching first, so the server keeps the start error for it and the two clients get different server outcomes for one gesture; and since OW-jopifu the clear reaches Emacs as `error-cleared`, not as a snapshot, so the Emacs-side sentence above about dropping drawn errors describes the code before OW-sedosu and OW-jopifu.
Confirm the trace with a test before changing anything, as that card asked.

Amended 2026-09-26: OW-lohubo's adversarial read contradicts the browser half of the amendment above: it reports that the browser also attaches in a call of its own before it prompts (`select` in `src/client/controller.ts` goes through `attachAndSelect`, which calls `api.attach`), so the route's read-before-attach would miss the start error for the browser too.
Neither claim has been checked against the first-prompt path on a new or previewed session; the test this card asks for settles which client gets which outcome.

Done when a test in `src/server/http/` or `src/emacs/` (whichever the fix lands in) drives an attach whose start raises an error, then a prompt as the Emacs helper sends it, and finds the session's error still set after admission — red first — and the existing prompt-route tests of OW-31 and OW-bipume still pass under `bun run check`.
