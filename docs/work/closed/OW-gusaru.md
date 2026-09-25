---
labels: [defect, emacs]
closed: done
---

# The Emacs helper drops a session's opening snapshot when a rename and a re-attach elsewhere both fell in one stream outage, so its buffer freezes

Found 2026-09-25 by the adversarial read of OW-danifa, confirmed by reading `src/emacs/helper.ts`, not reproduced against a running helper.
The Emacs half of OW-keleti, which files the same sequence for the browser's reducer; per "Both clients" in `AGENTS.md` each client carries its own card.
In service of D21's reconnect gap being closed in agentpane-mode for every case D24 says it is.

## What happens

The helper keeps `attached`, a map from each handle Emacs attached to the `sessionKey` of the ref it last told Emacs.
In `onEvent`, the block under the comment "A ref names one live session, and a snapshot is what introduces one under a new handle" moves an attachment onto a snapshot's new handle only when the snapshot's ref equals the ref last told.
The sequence: Emacs holds R under handle H1; while the helper's stream is down, another client detaches R and attaches it again, so the server mints H2, and the session is renamed to R2, as a first prompt on a virtual session does (D9).
On reconnect the opening snapshot carries H2 with R2, `told` for H1 is still R, so nothing moves, `isAttached(H2, R2, R2)` fails, and the snapshot and everything after it under H2 is dropped.
The buffer in `emacs/agentpane.el` keeps H1, counts itself attached, and shows a frozen transcript until `g` attaches again.

## A direction, not a prescription

As OW-keleti suggests for the browser, the listing is authoritative about which handles are live, and the helper refetches nothing on reconnect but tells Emacs `sessions/changed`.
Whether the helper, the mode, or a re-list decides that H1 is dead and R2 under H2 is the same session is the executor's call; the server's `#names` in `src/server/http/session-manager.ts` knows R and R2 name one container, and neither client does.

## Done when

A test in `src/emacs/helper.test.ts`, red first against the helper as OW-danifa left it: attach R under H1, drop the stream, reopen it with an opening snapshot under H2 carrying R2, and Emacs receives that snapshot, or some notification that lets the buffer holding H1 recover, which the test names.
The D21 sentence about agentpane-mode in `docs/DESIGN.md` (the one OW-danifa rewrote in the passage beginning "Since OW-kimaya that strands nothing in the browser") stays true after the fix, or is corrected in the same change.
`bun run check` green.

## Close note

Built: the Emacs helper no longer moves an attachment by comparing a snapshot's ref with the ref it last told Emacs.
A snapshot under a handle no attachment holds starts `reconcile` in `src/emacs/helper.ts`.
For each attachment, `reconcile` asks a new read-only route, `GET /api/sessions/:backend/:id/live` (`SessionManager.liveSummaryOf`).
The route answers the live summary a name reaches by any of its container's names, or 404, and it starts and broadcasts nothing.
An attachment answered under another handle moves there.
The snapshot then goes out carrying `movedFrom`, and `agentpane--notified-buffer` in `emacs/agentpane.el` routes it to the buffer holding that handle.
The old ref-match block in `onEvent` is retired, not supplemented.

Verified:
- The helper test for re-attach elsewhere, then rename, in one outage was red against the old helper ("only 3 of 4 frames arrived").
- Four more helper tests each went red by breaking their line: the rerun loop, the askedFor hand-over, storing the told ref, and the stopped check.
- Three route tests in `src/server/http/app.test.ts` cover the route.
- An ert test was red against the old mode.
- `bun run check` passes, 1438 tests; ert ran 113, 110 as expected and 3 skipped.

Scope: this heals only a re-attach followed by a rename of the re-attached container.
The adversarial read measured in a scratch server that a virtual session cannot be re-attached once closed (attach on its ref 404s).
So D9's first-prompt rename, the example this card led with, can only fall before a close, and that order is still open as OW-nibihi.
D21 and D24 in `docs/DESIGN.md` now say exactly that.

Filed from the review:
- OW-nibihi: the rename-before-close order, as the ownership change the AGENTS.md sibling rule asks for.
- OW-ruzazi: a failed lookup is never retried.
- OW-nukuse: a detach crossing a move leaks the attachment.
- OW-novone: the drop branch leaves a second buffer frozen, depending on order.
