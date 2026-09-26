---
labels: [defect, emacs]
closed: moot
---

# Emacs attaches before its first prompt, so the server reads the prompt's prior error after the start and clears one the start raised

Filed 2026-09-25 by OW-sedosu's adversarial read, traced through the code and not probed; confirm the trace before changing anything.

The prompt route in `src/server/http/app.ts` reads `priorError` before its own attach, and its comment says why: "an error its start raises is not one the sender saw, so admitting this prompt must not clear it (OW-31, OW-bipume)".
The Emacs helper never reaches that attach for a first prompt.
`agentpane--send-prompt` in `emacs/agentpane.el` goes through `agentpane--attached-then`, which sends `sessions/attach` first, and the helper's `sessions/attach` handler in `src/emacs/helper.ts` calls `api.attach`, so the session is running by the time `sessions/prompt` POSTs, and the route's `sessions.errorOf(ref)` reads the error the start raised as the prior.
Sequence: Emacs on a previewed session, holding no error, sends; the attach's start raises "X" and its snapshot draws "X"; the prompt POSTs with the server's prior now "X"; `SessionManager.submit` clears "X" and broadcasts; Emacs's line goes.
The browser, per the reader, POSTs a first prompt without attaching first, so for it the server keeps "X".
So the two clients get different server outcomes for the same gesture, and the one Emacs gets breaks the server's own rule.
Emacs's slot rule (OW-sedosu) would keep "X" — its prior is nil — but the server's clearing snapshot overrules it.

In service of `AGENTS.md`, "Both clients".
Load-bearing: for a prompt that starts a session, the prior error the server compares against is the one standing before the start, whichever client sent it.
Incidental: whether that is fixed by the helper not attaching separately before a first prompt, by carrying the client's prior on the prompt request, or otherwise — weigh against why `agentpane--attached-then` attaches first (its docstring, and OW-nasofa's single-send rule in `agentpane--send-prompt`).

Done when a test drives a first prompt through the Emacs path — a helper test in `src/emacs/helper.test.ts` against the fake server, or a server test in `src/server/http/app.test.ts` that attaches then prompts as the helper does — whose start raises an error, and shows the server still holds that error after the prompt is admitted, red before the change; and `bun run check` and the ERT suite pass.

## Close note

Duplicate of OW-bomolu, filed one run earlier on 2026-09-25 by OW-vulusi's adversarial read; this card came from OW-sedosu's read of the same code the next card over, and neither filing swept the open pile.
Same sequence, same cause, same load-bearing line: the prior error the server compares against at a first prompt is the one standing before the start, whichever client sent it.
What this card added over OW-bomolu, the browser contrast and the post-OW-jopifu wire, is noted on OW-bomolu.
