---
labels: [question, sweep-0929]
---

# Decide how both clients learn that a selected session is gone, since the preview route answers an empty transcript and a vanished session alike and each client guesses around it

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
Two of the sweep's readers reached this from opposite clients; it is shaped like D24 and D25 and is expected to become D26 in `docs/DESIGN.md`, filing its own cards as they did.

## What the server cannot say

`readSessionPreview` in `src/server/sessions/preview.ts` returns `[]` for a ref whose file it cannot find, on all three backends, and the `preview` case of `sessionAction` in `src/server/http/app.ts` never consults the session table ("This deliberately never touches `sessions`").
So "held, with nothing on disk yet" and "gone" come back as the same answer.
`SessionManager.summaryOf` in `src/server/http/session-manager.ts` already looks a ref up without spawning.

## The guesses built around it

- `detach()`'s no-disk exit and its own re-list in `src/client/controller.ts`, kept as an exception by D21.
- `onDisconnect`'s no-disk branch in the same file.
- `agentpane-close-session` in `emacs/agentpane.el` asking a follow-up listing to decide whether to kill the buffer.
- `agentpane--dropped` in `emacs/agentpane.el`: set by `agentpane--let-go`, cleared by `agentpane--attach-by` and `agentpane-close-session`, and read in exactly one place, `agentpane-refetch`'s `(or agentpane--attached agentpane--dropped)`, where it makes `g` re-attach instead of preview.
  The browser has no such flag: OW-forinu derives `paneMode`, and a dropped view falls to preview or loading with an explicit Attach.

## The proposal to decide

1. The preview route answers `404 not_found` when the index finds no file and the manager holds nothing under that name.
   `loadPreview` in `src/client/controller.ts` treats `not_found` as gone and clears the selection, and a row click in `preview()` routes through `loadPreview`.
2. `agentpane--dropped` retires: an Emacs buffer is live exactly when attached, `g` otherwise previews, and an attach-only command (OW-bupivi) becomes the explicit way to go live beside send, fork and edit, which already attach through `agentpane--attached-then`.
3. `detach()`'s no-disk exit, `onDisconnect`'s no-disk branch and D21's paragraph about the exception go.

It costs two amendments, which is why it is a question and not a change:
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

The decision is recorded in `docs/DESIGN.md` as D26, with D25 decision 4, D21's exception paragraph and OW-bilogo's docblock rule amended to agree, and the fork-on-disk measurement recorded in `docs/MANUAL_TESTING.md`.
Whatever the answer, each card named under "What it would settle" is closed or amended to say what this decision means for it, and the implementation cards D26 calls for are filed, labelled `sweep-0929`, one per client where the Both clients rule in `AGENTS.md` asks for it.
