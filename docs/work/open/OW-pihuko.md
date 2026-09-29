---
labels: [defect, sweep-0929]
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
