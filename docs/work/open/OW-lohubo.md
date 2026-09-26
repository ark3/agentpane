---
labels: [defect]
blocked-by: [OW-jopifu]
---

# Both clients still clear a held error at a prompt's reply by matching its text, so a newer error with the same text is dropped while the server holds it

Filed 2026-09-25 by the adversarial read of OW-jopifu, which reproduced the browser half with a throwaway controller test and traced the Emacs half through the code.

Each client clears the session's turn error itself when its own prompt's reply arrives, if the error it holds then is still the one it held at the send (OW-31):
- the browser in `submit` in `src/client/controller.ts`, the line `currentError === priorError ? clearSessionError(view.state, handle) : view.state`;
- Emacs in `agentpane--send-prompt` in `emacs/agentpane.el`, the reply callback's `(when (and prior (equal agentpane--error prior)) (agentpane--hold-error nil))`.

That comparison is by message text, and a turn error's text often repeats.
Sequence: the client holds "The turn ended in an error." and sends; the server admits the prompt, clears the error and broadcasts `error-cleared`; the new turn fails at once with the identical text and the server broadcasts `error`; the client handles both events before the prompt's reply, which D2 allows and which jsonrpc.el's held-back reply makes likely in Emacs; the reply finds the same text and clears it.
The server still holds the error, every other client still shows it, and this one does not.
The reader's probe: in `src/client/controller.test.ts`, emit a snapshot, then `error` (seq 2); `submit()` with a deferred prompt; emit `error-cleared` (seq 3), then `error` (seq 4, same text); resolve the prompt; the held error is `null` where the server's is the text.

The case predates OW-jopifu, since the old admission snapshot produced the same sequence.
What OW-jopifu changed is that the server now announces every clear, the prompting client included, as `error-cleared` (`SessionManager.submit` in `src/server/http/session-manager.ts`, sent before the prompt's `202`), so the reply-time clear is a second owner of the same state.
Per `AGENTS.md`, "Evidence", on a guard whose adversarial read names a case it misses, this card is the ownership change and not a second guard: the server owns the error, and each client drops it only when the event stream says so.

## The change

Retire the reply-time clear in both clients, and let `error-cleared` be what drops the error for the prompting client as it is for the others.
Load-bearing: after the change no client clears its held turn error on a prompt's reply.
The prompt route's `priorError` and OW-lokima (Emacs's attach-then-prompt reads the prior after the start) stay as they are; this card changes only who drops the error on the client.
Weigh, and record in the docstrings, what the prompting client shows between the reply and the event when the two arrive in the other order: the error stays up a moment longer, which is the server's truth.
The docblocks that describe the retired clear change with it: the comment above it in `controller.ts` ("a same-turn error can otherwise race in and be wiped by this same submit's own success handler"), the `agentpane--send-prompt` and `agentpane--error` docstrings, the Commentary paragraph in `emacs/agentpane.el` beginning "A buffer holds one turn error, the one the server holds", and the comment in `SessionManager.submit` that says the prompt's own client has already dropped it.

## Done

Red first, then green:
- in `src/client/controller.test.ts`, the probe above ends with the error still held;
- in `emacs/agentpane-test.el`, the same sequence (`session/errorCleared`, then `session/error` with the held text, then the prompt's reply) ends with the `⚠` line still drawn;
- the existing tests that pin the reply-time clear (among them OW-vulusi's `agentpane-test-admitted-prompt-drops-the-drawn-error` and `agentpane-test-admitted-prompt-keeps-a-newer-error`, and the browser's OW-31 tests in `controller.test.ts`) are rewritten to drop the error on `error-cleared` instead, or retired where they only pinned the retired clear.
`bun run check` and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, pass.
