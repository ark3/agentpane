---
labels: [defect]
blocked-by: [OW-yirosu]
---

# A cleared turn error has no event of its own, so a dismissal never reaches the other clients and a prompt's admission clears one only by a full snapshot

Found by the adversarial read of OW-yirosu on 2026-09-25.

The server holds a session's turn error on its container (`ManagedSession.error` in `src/server/http/session-manager.ts`, the docblock that opens "What the adapter's `onError`, `onRequest` and `onNotice` have said, held for every snapshot to carry (OW-bipume)").
Two places clear it: `SessionManager.clearError`, reached by a client's dismissal through the `clearError` route in `src/server/http/app.ts`, and `SessionManager.submit` at a prompt's admission.
Neither has a wire event of its own; a client learns the error went only from a snapshot carrying `error: null`.
A pending request is the model of the fix: `clearRequest` retracts it on the wire with `broadcaster.requestResolved`, and an error has no such retraction.

Before OW-yirosu this cost little, because every prompt broadcast three snapshots — the prompt route's attach and both turn boundaries.
OW-yirosu removed all three, so:
- A dismissal in one client (browser tab A, say) sets `session.error = null` and sends nothing; tab B, or an Emacs buffer on the same session, keeps drawing the error through any number of later turns, until it reconnects or re-attaches.
  The `clearError` docblock ("Only the next snapshot says so: the other clients showing it keep it until then") was written when the next snapshot was one prompt away; it is now unbounded.
- OW-yirosu kept the admission case working by having `submit` broadcast a whole snapshot when it clears a held error (the comment there cites OW-yirosu).
  That is a guard at one clearing site that misses the other, and it costs every client — the sender's Emacs buffer included — the full re-project and redraw OW-yirosu existed to remove, on each prompt that follows a turn error.

## The change

Clearing a held turn error goes out as an event of its own, at both clearing sites, and the admission snapshot in `submit` is retired.
The shape is the implementer's call: an `error`-cleared event, or `error` carried on the `status` event, or something else that is small; what is load-bearing is that no snapshot is needed to say an error went.
The dismissal must keep OW-bipume's rule that a newer error is not cleared by a dismissal naming an older message (`session.error === message` in `clearError`).
Per "Both clients" in `AGENTS.md`, this lands in the browser (`reduceServerEvent` in `src/client/session-state.ts`, `src/client/controller.ts`) and in Emacs (the helper's notification in `src/emacs/helper.ts` and `src/emacs/protocol.ts`, and `emacs/agentpane.el`, where OW-vulusi's match-by-message drop at admission already lives) in the same change, or the wire change lands alone and each client gets its own card blocked by it, the Emacs one labelled `emacs`.

## Done

Red first, then green:
- in `src/server/http/app.test.ts`, two SSE clients on one session holding an error; one dismisses; the other receives an event saying the error is gone, with no snapshot;
- a prompt admitted over a held error broadcasts that event and no snapshot (the two tests OW-yirosu added in `src/server/http/session-manager.test.ts`, "snapshots a prompt's admission when it cleared a held error, so every client drops it" and "sends no snapshot for a prompt's admission when no error was held", change to match);
- each client's suite shows a drawn error removed on that event — `src/client/` for the browser, `src/emacs/helper.test.ts` and `emacs/agentpane-test.el` for Emacs.
`bun run check` passes, and the `clearError` docblock and the `submit` comment are corrected in the same change.
