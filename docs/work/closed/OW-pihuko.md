---
labels: [defect, sweep-0929]
closed: done
---

# The browser keeps a live view of a session another client closed with nothing on disk, because its listing drops only rows marked detached and a closed no-disk session has no row at all

Filed 2026-09-29 by a sweep of the open deck for consolidations; read from the code at e1cf2e6, not reproduced.

`replaceSessionSummaries` in `src/client/session-state.ts` evicts a live view only for a summary whose `status` is `"detached"` (`if (summary.status !== "detached") continue;`).
A session with nothing on disk that another client closes leaves no summary at all: `list()` in `src/server/http/session-manager.ts` lists stored files plus the live table, and the server sends nothing per session on close (`broadcaster.forget` only).
So the browser keeps the view, the pane stays `live` under OW-forinu's derived `paneMode` in `src/client/controller.ts`, the composer is drawn over a session that no longer exists, and Send gets 409 `not_attached`.
This is the ordering OW-zivamo named and OW-forinu covered for a row that *is* listed `detached`; the only listing-eviction test, "previews a selected session a listing evicts, and sends it nothing (OW-zivamo)" in `src/client/controller.test.ts`, lists the row.

The Emacs helper does not have this defect.
`dropDead` in `src/emacs/helper.ts` (OW-yibijo) drops every handle held when the listing was asked for that the listing lacks, on terms its docblock spells out.

## The change

The browser takes the helper's rule: a view held when the listing was asked for, whose handle the listing does not carry, goes.
Keep the `detached`-status drop beside it, since a container can sit in the table without an adapter.
The existing `sessionsWhenListed` argument is already the "held when asked" test, and OW-fihuma's rule that a view an event touched since is newer than the listing still holds.
Whether the rule moves into shared code both clients use, or is stated twice, is the implementer's call; say which in the docblock.

A selected session this evicts falls to its preview, where the preview read answers `[]` for a session that is gone; what that should say instead is OW-zavehi's question, not this card's.

## Done when

A red-first test in `src/client/controller.test.ts`, sibling of the OW-zivamo test: S attached and selected with nothing on disk, a re-list that omits S entirely, and the assertions that S's view is gone, the pane is not `live`, and `submit` issues no `api.prompt`.
A unit test in `src/client/session-state.test.ts` that a view absent from `sessionsWhenListed` survives a listing that lacks it.
`bun run check` passes.

## Close note

Built: `replaceSessionSummaries` in `src/client/session-state.ts` now drops every view held when the listing was asked for (`sessionsWhenListed`) whose handle no listed summary carries, before the existing detached-by-ref pairing.
It is the Emacs helper's `dropDead` rule, stated twice rather than shared; the docblock says why.

It departs from the card on one point: the card said OW-fihuma's "touched since is newer" rule still holds, and the drop does not honour it.
An adversarial reader showed, and review confirmed in `#container`, `#add` and the snapshot source in `src/server/http/session-manager.ts`, that a held view's container was in the table before `list()` read it and a handle is never minted twice (D24), so a missing handle is dead however new its view.
Keeping touched views let a Compact or Dismiss click in the window leave a dead pane live with no listing owed.
Running the drop first also stops the pairing loop restoring an `attached` summary for a view the drop removed.

Verified: the controller test "drops the view of a selected session a listing omits, and sends it nothing (OW-pihuko)" and a unit test in `src/client/session-state.test.ts` (held view dropped; unheld view kept; touched held view dropped; and the detached listing keeps its listed summary) were each shown red first, against the unfixed code, the freshness guard and the old loop order respectively.
`bun run check` green: 54 files, 1503 tests.

Filed OW-denuse, the sibling question of whether the server announces a handle's end on the stream instead, which D25 had decided against; it carries the two cases the listing inference still misses, the disposal window before `close()` sends `sessions-changed` and a failed listing nothing re-asks.
Amended OW-zavehi: a selected no-disk session this drop evicts keeps its selection and lands on the empty preview, one more path that decision sets.
