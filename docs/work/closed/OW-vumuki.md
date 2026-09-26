---
labels: [defect]
closed: moot
---

# The server clears a dismissed turn error without telling any client, so a stale snapshot redraws it

Filed 2026-09-25 by OW-sedosu's adversarial read, which confirmed the Emacs half with a probe ERT test and traced the browser half through the code.

`SessionManager.clearError` in `src/server/http/session-manager.ts` ("A client dismissed the session's error") sets `session.error` to null and broadcasts nothing; its docblock accepts that "the other clients showing it keep it until then".
`SessionManager.submit`, since OW-yirosu, does broadcast a snapshot whenever it clears the held error ("No event but a snapshot says an error went").
Both clients now rely on that pattern: a snapshot sets their held error unconditionally (the `session/snapshot` arm in `src/client/session-state.ts`, and `agentpane--draw` setting `agentpane--error` in `emacs/agentpane.el`), and the `agentpane--error` docstring's case for letting a stale snapshot through is that the clearing snapshot follows it on the ordered event stream.
Dismissal breaks that premise in two ways.

1. A stale snapshot redraws what the user just dismissed, and it stays.
   The client holds "A"; the server broadcasts a snapshot carrying "A" (a re-attach such as `g` on an attached Emacs buffer, another client attaching, a compaction, a hydrate); the user dismisses before that snapshot is handled, so the client clears locally and sends `dismissError "A"`; the snapshot is handled and draws "A" again; the server clears "A" and says nothing.
   The line stays until the next snapshot, or this client's own next prompt.
   Emacs and the browser (`clearError` in `src/client/controller.ts` clears locally without waiting) share it.
2. Another client's dismissal never reaches a client already showing the error, and an old snapshot carrying it, handled after a prompt whose `priorError` was null, is never followed by a clearing one.

In service of `AGENTS.md`, "Both clients", and OW-sedosu's intent that each client show exactly the error the server holds.
Load-bearing: a dismissal that clears the held error is announced on the event stream, after the clear, as `submit`'s clear is; a snapshot is what `submit` uses today, and whether a cheaper event carries it instead is the executor's call, provided both wires carry it (the HTTP event stream, and the Emacs helper's notifications in `src/emacs/protocol.ts`, whose `session/snapshot` docblock line "`null` again once a later prompt is admitted" is also broader than the server's rule and should be corrected in the same change).
A dismissal naming a message the server no longer holds changes nothing and needs no announcement.

Then update the prose that states the premise: the `agentpane--error` docstring ("Since OW-yirosu, `submit' broadcasts a snapshot whenever it clears the error"), the Commentary paragraph near the top of `emacs/agentpane.el` beginning "A buffer holds one turn error, the one the server holds", and the `clearError` docblock.

Done when:
- a test in `src/server/http/session-manager.test.ts` (beside the existing `clearError` tests, "turn failed" and "first turn failed") shows a matching dismissal announces the clear and a non-matching one does not, red before the change;
- an ERT test in `emacs/agentpane-test.el` walks case 1 above — a snapshot carrying "A" handled after `C-c C-d`, then the announcement — and ends with no `⚠` line;
- `bun run check` and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, pass.

## Close note

Duplicate of OW-jopifu, which was amended at execution on 2026-09-25 to carry this card's cases and done conditions: the dismissal is now announced as `error-cleared` on both wires, the stale-snapshot-after-dismissal case is walked by an ERT test and a browser controller test, and the prose this card named (the `agentpane--error` docstring, the Commentary paragraph, the `session/snapshot` docblock line in `src/emacs/protocol.ts`, the `clearError` docblock) is corrected there.
