---
labels: [change, emacs]
---

# After a stream reopen the Emacs helper drops each attachment whose handle the listing lacks and tells its buffer, retiring the per-ref lookup that reconciles today

Authored 2026-09-25 from a survey of the helper race cards OW-gusaru's review filed, as the ownership change the sibling rule in `AGENTS.md`, "Evidence", asks for.
OW-nibihi is that sibling as filed, and its proposed owner, a server-side tombstone of each closed container's handle and names, is one more rename tracker of the kind D24 exists to remove; this card replaces its direction and, on landing, closes it.
Nothing here was reproduced against a running helper; the sequences are the ones OW-gusaru, OW-nibihi, OW-novone, OW-ruzazi and OW-nukuse each reasoned or measured.

## The state and its owner

The helper in `src/emacs/helper.ts` keeps `attached`, handle to the ref it last told Emacs, and nothing tells it a handle died.
Since OW-gusaru it learns of a move only when a snapshot arrives under a handle no attachment holds, and then asks the server per attachment, through `GET /api/sessions/:backend/:id/live` (`SessionManager.liveSummaryOf` in `src/server/http/session-manager.ts`), which handle the ref it told Emacs names now (`reconcile`), and moves the attachment there with a `session/snapshot` carrying `movedFrom`.
Each case that lookup misses is a card: no name survives a close, so the lookup answers 404 (OW-nibihi); another buffer takes the new handle before the answer lands, so the drop branch tells Emacs nothing (OW-novone); a failed request reads as "not live" and is never retried (OW-ruzazi); a detach crossing the move names the handle the helper just left (OW-nukuse).
Those are four faces of one thing: the helper is working out, per ref, where a session went, and only the server's `#names` knows that.

The listing already says which handles are live.
`SessionManager.list` puts `handle` on every summary whose container is in the table, skips a name a container outgrew (the comment beginning "A name a held container has outgrown"), and, asked with no `cwd`, lists every live session.
And the one verb that resolves a ref by any of its container's names is `attach`: an attach through an old name answers the summary under the current handle and ref, which the `sessions/attach` handler in the helper and `agentpane--attached-as` in `emacs/agentpane.el` already handle, including a reply naming a handle another buffer holds (`agentpane--absorb`) and a rename the reply carries (`askedFor`).
So the helper need not work out where a session went.
After a reopen it asks the listing which of its handles are still held; a handle the listing lacks is dead, the attachment is dropped, and the buffer is told; the buffer's own next attach, by `g` or by a prompt through `agentpane--attached-then`, finds the session by its ref wherever it is now, which is what OW-35 asks of a reaped session too.
This is the rule OW-keleti gives the browser, amended today to say so: the listing after a reopen owns which handles are live, and both clients take it.

## What changes

Load-bearing:
- On every reopen of the helper's stream (`onOpen` with `opens > 1`, which already sends `sessions/changed`), the helper lists unfiltered and drops each attachment held when the listing was asked for whose handle the answer lacks, telling Emacs by a notification under that handle.
  Only a handle held when the listing was asked for can be dropped by its answer: an attach answered meanwhile mints a handle the listing predates.
- The notification is one Emacs acts on: the buffer holding that handle lets go of it (`agentpane--handle` and `agentpane--attached` cleared), keeps its ref and its drawn transcript, and reads as detached.
  Letting go of the handle is what makes its next attach a first attach of whatever handle answers, so the `askedFor` route in `agentpane--notified-buffer` carries a rename to it and `agentpane--attached-as` merges it into a buffer already holding the handle.
  A buffer that kept a dead handle and re-attached under a new ref may drop its own attach's snapshot today, since no route in `agentpane--notified-buffer` matches a buffer holding one handle and one ref to a snapshot under another of each, and whether it does depends on whether the reply or the snapshot is handled first.
- `reconcile`, `liveSummary`, the `live` route, `liveSummaryOf` and `movedFrom` are retired, not supplemented, with their copies: the docblocks in `src/emacs/helper.ts` and `src/emacs/protocol.ts`, the `movedFrom` paragraph of `agentpane--notified-buffer`'s docstring, the `live (OW-gusaru, read-only, non-attaching)` block in `src/server/http/app.test.ts`, and the reconcile tests in `src/emacs/helper.test.ts` from "moves an attachment onto the handle the server says its ref names now" to "drops an attachment whose ref the server says names a handle another attachment holds".
  Grep `movedFrom`, `reconcile` under `src/emacs/` and `emacs/`, `ROUTES.live` and `liveSummaryOf` for the rest.
- The "snapshot by the ref, where the buffer holds a handle" route in `agentpane--notified-buffer` stays: a `g` on a dead handle with the stream up, which nothing here tells the buffer about, is still answered under a new handle by that route.

Incidental, the executor's call, stated in the close note:
- The notification's name and shape in `src/emacs/protocol.ts`; `session/detached` with `{ session, handle }` is one.
- Whether the same check also runs on each `sessions-changed` while the stream is up, which would tell a buffer of a close elsewhere, OW-nibihi's "more generally", at the cost of a listing per event beside the two the browser and Emacs already ask for.
- Whether the helper lists for itself or reads the listing Emacs asks for, which `sessions/list` may filter by `cwd`.

Accepted: one listing per reopen in the helper, beside the one Emacs already asks for on `sessions/changed`; and after a server restart every attached buffer reads as detached and comes back on `g` or on its next prompt, where today it reads as attached over a frozen transcript and comes back the same way.
Declined: re-attaching every buffer from the helper on reopen, which would respawn one backend process per open buffer on every restart, wanted or not.

## Done when

- A test in `src/emacs/helper.test.ts`, red first against the helper as OW-gusaru left it: attach R under H1, drop the stream (`source.opens[0].onDisconnect`, as "relays sessions-changed, and reopens a dropped stream with a sessions/changed after every reopen" drives it), answer the reopen's listing with R2 attached under H2 and no H1, and Emacs receives the notification under H1 and nothing more under it, with no `GET .../live` among the calls.
- A second, in which an attach answered under H3 while that listing is in flight is not dropped by its answer.
- A third driving OW-nibihi's sequence, rename then close then re-attach by the new ref under H3, which gives the same notification, since the orders no longer differ.
- An ert test in `emacs/agentpane-test.el`, red first: a buffer holding H1 receives the notification, is no longer attached, holds no handle, keeps its transcript, and a `g` then sends `sessions/attach` for its ref; and a second in which that attach's snapshot arrives under H2 carrying `askedFor`, and the buffer takes H2 and redraws.
- The D21 paragraph in `docs/DESIGN.md` from "A snapshot under a handle no attachment holds sends the helper to the server's read-only `live` route" through "Still open is the other order", and the D24 sentence ending "(D21, OW-nibihi)", say the new rule and name what remains open, if anything does.
- `bun run check` green, and the ert suite run as the Commentary of `emacs/agentpane.el` gives it.
- On landing, OW-nibihi, OW-novone, OW-ruzazi and OW-nukuse close `--moot` naming this card; each is blocked by it until then so none runs first.
