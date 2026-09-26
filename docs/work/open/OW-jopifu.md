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
A dismissal naming a message the server no longer holds changes nothing and needs no announcement.
Per "Both clients" in `AGENTS.md`, this lands in the browser (`reduceServerEvent` in `src/client/session-state.ts`, `src/client/controller.ts`) and in Emacs (the helper's notification in `src/emacs/helper.ts` and `src/emacs/protocol.ts`, and `emacs/agentpane.el`, where the buffer-local slot `agentpane--error` owns the error since OW-sedosu) in the same change, or the wire change lands alone and each client gets its own card blocked by it, the Emacs one labelled `emacs`.

## Amended at execution, 2026-09-25

OW-sedosu landed after this card was filed and retired OW-vulusi's match-by-message drop: Emacs now holds one error in `agentpane--error`, which a snapshot always sets, and whose docstring rests on OW-yirosu's admission snapshot ("Since OW-yirosu, `submit' broadcasts a snapshot whenever it clears the error").
OW-sedosu's adversarial read then filed OW-vumuki, the same missing announcement seen from the dismissal side, with one case this card did not name, now folded in here:
a client holds "A"; the server broadcasts a snapshot carrying "A" (a re-attach, another client attaching, a compaction, a hydrate); the user dismisses before that snapshot is handled, so the client clears locally and sends the dismissal; the snapshot is handled and draws "A" again; the server clears "A".
With the announcement, the stale line goes when the event arrives, since the event stream is one ordered stream and the clear follows the stale snapshot on it.
The browser shares the case, since `clearError` in `src/client/controller.ts` clears locally without waiting.

The prose that states the premise changes with it: the `agentpane--error` docstring, the Commentary paragraph near the top of `emacs/agentpane.el` beginning "A buffer holds one turn error, the one the server holds", and the `session/snapshot` line in the docblock of `src/emacs/protocol.ts` reading "`null` again once a later prompt is admitted", which is broader than the server's rule.

## Done

Red first, then green:
- in `src/server/http/app.test.ts`, two SSE clients on one session holding an error; one dismisses; the other receives an event saying the error is gone, with no snapshot;
- a prompt admitted over a held error broadcasts that event and no snapshot (the two tests OW-yirosu added in `src/server/http/session-manager.test.ts`, "snapshots a prompt's admission when it cleared a held error, so every client drops it" and "sends no snapshot for a prompt's admission when no error was held", change to match);
- in `src/server/http/session-manager.test.ts`, beside the existing `clearError` tests ("turn failed", "first turn failed"), a matching dismissal announces the clear and a non-matching one does not;
- each client's suite shows a drawn error removed on that event — `src/client/` for the browser, `src/emacs/helper.test.ts` and `emacs/agentpane-test.el` for Emacs;
- an ERT test in `emacs/agentpane-test.el` walks the stale-snapshot case above — `C-c C-d`, then a snapshot carrying "A", then the announcement — and ends with no `⚠` line.
`bun run check` and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, pass, and the `clearError` docblock, the `submit` comment and the prose named above are corrected in the same change.
