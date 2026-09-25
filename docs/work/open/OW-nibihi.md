---
labels: [defect, emacs]
---

# A buffer whose session was renamed, closed elsewhere and re-attached by its new ref in one stream outage stays frozen, since no name links the handle it holds to the new one

Found 2026-09-25 by the adversarial read of OW-gusaru. The order was confirmed in a scratch server test built on `createApp` with `FakeAdapterFactory({ materialiseOnSubmit })`, as in `src/server/http/app.test.ts` "live (OW-gusaru, read-only, non-attaching)". It was not reproduced against a running helper.
This is the sibling that AGENTS.md "Evidence" asks for ("A race fix that adds a guard at the site, and whose adversarial read then names a case the guard misses").
OW-gusaru moved the question of which handle a name reaches now to the server. Nothing yet owns the link from a handle that died to the session it became.
It serves D21's reconnect gap in agentpane-mode; `docs/DESIGN.md` D21 names this case as the residual OW-gusaru left.

## What happens

Emacs holds ref R under handle H1 while the helper's stream is down. During the outage:

1. The session is renamed R to R2. D9's first prompt on a virtual session is the common case.
2. Another client closes it.
3. Something attaches R2, so the server mints H3.

`SessionManager.close` drops every name of the closed container (`#remove` and `#names` in `src/server/http/session-manager.ts`).
So when the opening snapshot under H3 sends `reconcile` in `src/emacs/helper.ts` to `GET live(R)`, the answer is 404.
Nothing moves, and the buffer in `emacs/agentpane.el` keeps H1, counts itself attached, and shows a frozen transcript until `g`.
A virtual R cannot be re-attached at all once closed: attach on the virtual ref 404s, which the same scratch test showed. So D9's rename can only come before the close, and this order is the only one in which the example OW-gusaru's card led with can happen.
More generally, nothing ever tells the helper that a handle died. A close elsewhere with no re-attach also leaves a buffer that counts itself attached.

## A direction, not a prescription

The state with no owner is what a dead handle became.
One candidate: the server keeps a bounded tombstone of each closed container's handle and last names. The helper then asks by the handle it holds rather than by the ref it last told Emacs, and gets the session that handle's last name reaches now, or "closed".
If that lands, it retires the ref-keyed lookup in `reconcile`, which is the guard this card exists to replace. Say in the change which it retires.
A restarted server has no tombstones, so decide whether the ref lookup survives for that case alone. Do not keep both paths without saying what needs each.
Decide too whether a buffer whose session was closed elsewhere and not re-attached should be told so, over the wire in `src/emacs/protocol.ts`. OW-keleti holds the browser's half of the dead-handle question, and whatever the server answers here should serve it as well.

## Done when

A test in `src/emacs/helper.test.ts` goes red first against the helper as OW-gusaru left it.
It drives, or stubs from a real server sequence, this path: attach R under H1, drop the stream, rename to R2, close, re-attach R2 under H3, reopen with the opening snapshot under H3.
Then Emacs receives a snapshot under H3 that agentpane-mode routes to the buffer holding H1.
A server test shows the route, whatever shape it takes, starting and broadcasting nothing.
The residual sentence in `docs/DESIGN.md` D21, "What the helper still cannot follow is a rename before a close elsewhere", is corrected in the same change.
`bun run check` green.
