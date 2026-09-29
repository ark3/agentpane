---
labels: [question, sweep-0929]
closed: done
---

# Decide how both clients learn that a session or its handle has ended, since the server knows the moment it happens and each client instead infers it from listings and an empty preview

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
Two of the sweep's readers reached this from opposite clients; it is shaped like D24 and D25 and is expected to become D26 in `docs/DESIGN.md`, filing its own cards as they did.

Amended 2026-09-29 to absorb OW-denuse, filed while executing OW-pihuko, which closed `--moot` as folded into this card.
OW-denuse asked the same question from the handle's side — whether the server should say on the stream that a handle has ended — and the owner chose to decide both in one session, so that one fact does not get two mechanisms.
This card first asked only what a client shows for a selected ref that is gone; it now asks how a client learns that a session or its handle has ended at all, of which the selected ref is one consumer.

## What the server knows and does not say

The server knows a handle has ended at the moment it happens: `#remove` and `broadcaster.forget` in `close()`, `#forkOnto` and `disposeAll()` in `src/server/http/session-manager.ts`.
It says nothing under that handle on the event stream.
Both clients infer the end from a later listing instead: `replaceSessionSummaries` in `src/client/session-state.ts` drops a view held when the listing was asked whose handle the listing lacks (OW-pihuko) and, beside it, a view paired by ref with a `detached` summary (OW-fihuma); `dropDead` in `src/emacs/helper.ts` does the same for the helper's attachments (OW-yibijo).
`detach()` in `src/client/controller.ts` also drops its own view locally.
D25 chose the listing on 2026-09-28 ("The listing-based dropping at every `sessions-changed` while the stream is up stays in both clients, since another client's close is still a real case"); this card may amend that.

What the listing inference misses, as OW-denuse recorded it:
1. `close()` sends `sessionsChanged()` only after `await disposal.promise`, so for as long as the adapter takes to dispose — up to the kill grace — a session another client closed still shows `live`, and a Send gets 409 `not_attached`; `#forkOnto` sends it right after `forget`, so a fork elsewhere has no such window.
2. When the listing a `sessions-changed` asks fails, nothing asks again until the next one: `listSessions` in `src/client/controller.ts` swallows the error for a non-surfacing caller, and `dropDead`'s docblock says "A failed listing drops nothing", so a dead view can stay live indefinitely on a quiet server.
3. The listing is a whole-table read each time, taken only to learn which handles went.

OW-kamave is reframing `SessionManager`'s identity model for a startup in flight in parallel; a terminal event sent where `forget` runs does not depend on that, but read its state if it has moved.

## What the preview cannot say

`readSessionPreview` in `src/server/sessions/preview.ts` returns `[]` for a ref whose file it cannot find, on all three backends, and the `preview` case of `sessionAction` in `src/server/http/app.ts` never consults the session table ("This deliberately never touches `sessions`").
So "held, with nothing on disk yet" and "gone" come back as the same answer.
`SessionManager.summaryOf` in `src/server/http/session-manager.ts` already looks a ref up without spawning.

## The guesses built around it

- `detach()`'s no-disk exit and its own re-list in `src/client/controller.ts`, kept as an exception by D21.
- `onDisconnect`'s no-disk branch in the same file.
- `agentpane-close-session` in `emacs/agentpane.el` asking a follow-up listing to decide whether to kill the buffer.
- `agentpane--dropped` in `emacs/agentpane.el`: set by `agentpane--let-go`, cleared by `agentpane--attach-by` and `agentpane-close-session`, and read in exactly one place, `agentpane-refetch`'s `(or agentpane--attached agentpane--dropped)`, where it makes `g` re-attach instead of preview.
  The browser has no such flag: OW-forinu derives `paneMode`, and a dropped view falls to preview or loading with an explicit Attach.

Since OW-pihuko, a listing that lacks a held view's handle drops the view in `replaceSessionSummaries` in `src/client/session-state.ts`, and a selected session with nothing on disk dropped that way keeps its selection and lands on the empty preview with no sidebar row, where `detach()` and `onDisconnect` would have cleared the selection.
That is one more path whose outcome this decision sets.

## The proposals to decide

They are not exclusive, and deciding how they fit together is the point of this card: which one owns "this session or handle has ended", and which, if any, survive as a backstop.

A. A per-handle terminal event on the ordered stream, sent where `forget` runs and before the handle is forgotten, that the reducer in `src/client/session-state.ts` and the helper apply to drop exactly that view or attachment.
   It could carry whether anything is on disk, which would let a client clear a selection with nothing left to preview without asking the preview route at all.
   Were it adopted, name what it retires: the missing-handle drop and the detached-by-ref drop in `replaceSessionSummaries` (keeping OW-fihuma's summary restore only if something still needs it), `dropDead`'s eviction, and `detach()`'s local drop; and say what becomes of cases 1 and 2 above.
   A client that was not connected when the event went, which D25 already treats as holding nothing live, still learns from the listing at reconnect (D21).

B. The preview answers "gone", as below.

B1. The preview route answers `404 not_found` when the index finds no file and the manager holds nothing under that name.
   `loadPreview` in `src/client/controller.ts` treats `not_found` as gone and clears the selection, and a row click in `preview()` routes through `loadPreview`.
B2. `agentpane--dropped` retires: an Emacs buffer is live exactly when attached, `g` otherwise previews, and an attach-only command (OW-bupivi) becomes the explicit way to go live beside send, fork and edit, which already attach through `agentpane--attached-then`.
B3. `detach()`'s no-disk exit, `onDisconnect`'s no-disk branch and D21's paragraph about the exception go.

B costs two amendments:
- D25 decision 4, "a helper that crashed over a live server is rare, and costs a `g`" — `g` would then preview, and going live would take the attach command;
- OW-bilogo's rule, "A failed read is never an answer" at `loadPreview`'s docblock — a `not_found` would be a definite answer, not a failure.

One fact the proposal rests on is unmeasured: whether a parked fork's ref (held in `#pendingForks`, not the table) has its file on disk the moment `fork` returns, on Codex and on Claude Code.
If it does not, the route must consult `#pendingForks` too; measure it rather than assume, and record the answer with its CLI version.

## What it would settle

Moot outright: OW-lejape (both its orderings end at the fetch), OW-tuyewo (if the row click routes through `loadPreview`), OW-wabiju (a flag nobody clears), and case 1 of OW-reyayi (the dropped flag is what makes `g` respawn a session whose close landed).
Probably moot: OW-vetebu, whose `g` would get `not_found` instead of an empty preview.
Simplified: OW-tujami (its endless `g` then 404 goes; learning the renamed ref remains), OW-kafupo (gains a "this buffer is a preview" predicate to gate polling on), OW-bupivi (becomes required rather than optional).
OW-pihuko is its complement and is not blocked by this: it drops the dead view, and this card decides what the selection shows after.

## Done when

The decision is recorded in `docs/DESIGN.md` as D26, naming the one owner of "this session or handle has ended" and what each surviving mechanism is for, with D25's listing sentence and decision 4, D21's exception paragraph and OW-bilogo's docblock rule amended to agree; and, if B's route change is taken, the fork-on-disk measurement recorded in `docs/MANUAL_TESTING.md`.
Whatever the answer, the record says what becomes of cases 1 and 2 under "What the server knows and does not say".
If the terminal event is adopted, its cards are one carrying it onto both wires (the HTTP event stream and `src/emacs/protocol.ts`) and one per client blocked by it, the Emacs one labelled `emacs`.
Whatever the answer, each card named under "What it would settle" is closed or amended to say what this decision means for it, and the implementation cards D26 calls for are filed, labelled `sweep-0929`, one per client where the Both clients rule in `AGENTS.md` asks for it.

## Amended 2026-09-29 at execution

Two clauses of "Done when" changed as the decision was taken.
The fork-on-disk measurement is not needed: D26 point 5 counts a parked fork as held, so no backend's timing for a fork's file can make a held session read as gone, and the owner agreed on 2026-09-29 to cite the existing records rather than measure.
Those records: a regular Codex fork's rollout was on disk when `fork` returned on `codex-cli 0.148.0`, `0.154.0` and `0.156.0` (`docs/MANUAL_TESTING.md`, "Settling the fork's returned ref (OW-pifowo, OW-22)", OW-lajehi and OW-sayaju); a Pi fork's moved file was on disk at return on `pi 0.85.1` (OW-gajesu); a Claude Code fork and a Codex first-message fork send the CLI nothing at `fork` (`ClaudeAdapter.fork`, and `CodexAdapter.fork` since OW-hojefo), so neither has a file then, by construction.
OW-bilogo's docblock rule at `loadPreview` is amended by D26 point 6 in `docs/DESIGN.md` and changes in the code with OW-lilami, which makes the exception; a docblock that described the exception before the code made it would be false at the site.
Also, the preview's answer is `404` with the code `gone`, not `not_found`, which an unmatched route also answers (D26 point 5).

## Close note

Decided by the owner on 2026-09-29 and recorded as D26 in `docs/DESIGN.md`: proposal A, with B's preview answer folded in as the owner of a separate fact.
The one owner of "this handle has ended" while a client's stream is up is an `ended` event the server sends, with no `seq` and no on-disk flag, where `close()` and `#forkOnto` forget the handle; `close()`'s `sessions-changed` moves to the same run.
The listing no longer drops views, attachments or held attaches in either client, with no backstop kept: D25 made the stream all or nothing, and the Emacs helper now waits for its stream's open before a request that needs its events, which an adversarial read showed it did not.
The one owner of "this ref has nothing to show" is the preview route, answering `404` with the code `gone` (not `not_found`, which an unmatched route also answers) when the manager holds nothing under the name, parked forks and startups in flight included, and then the index finds no file.
The browser clears its selection on `gone` from any preview read; agentpane-mode's `agentpane--dropped` goes, `g` previews a buffer that is not attached, and `gone` kills the buffer.
Case 1 (a close elsewhere reading live through the disposal) is gone by the event's timing; case 2 (a failed listing) shrinks to a stale row until the next listing.
Amended D21's detach exception, D25's listing sentence and decision 4, and named in D26 the rest that change with the code, OW-bilogo's docblock rule among them (changed with the code in OW-lilami, which makes its exception).
The fork-on-disk measurement was not taken, by the owner's agreement: counting parked forks as held makes it non-load-bearing, and the existing records are cited in this card's last amendment.
Two adversarial reads, one at D26 and one at the cards, found four defects in the design and a dozen in the cards; all were fixed before commit.
Filed, labelled `sweep-0929`: OW-sodohi, OW-vebeno, OW-likopo, OW-royosa (blocked by OW-kamave), OW-lilami and OW-vugefa (blocked by OW-bupivi too).
Closed moot into them: OW-lejape, OW-tuyewo, OW-wabiju, OW-vetebu; amended: OW-reyayi, OW-tujami, OW-kafupo, OW-bupivi, OW-savafi, OW-puzome, OW-pezelo, OW-kamave.
