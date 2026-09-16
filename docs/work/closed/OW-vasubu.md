---
labels: [defect]
closed: done
---

# A virtual detach should clear the selection and land on the startup view, not preview a session that has nothing to preview

`src/client/controller.ts` (`detach()`), `src/client/App.svelte` (the `{#if previewing}` branch).

Found while reviewing OW-tewave, which decided deliberately that Detach is offered for a `virtual` selection and that its row then vanishes from the listing, because `list()` is disk plus the table and a virtual session has nothing on disk.
That much the owner accepted on 2026-09-16 and it is not in question here.

`detach()` calls `controller.preview(selected)` unconditionally.
For a virtual session there is nothing to preview: `readSessionPreview` answers a `virtual:` ref with `[]` rather than an error, because `resolvePiSessionPath` returns null.
An empty *non-null* preview is what manufactures the problem -- `view.preview` is set, so `App.svelte` swaps to its `{#if previewing}` branch, whose whole composer is one Attach button.
The row is gone by then, so `selectedSummary` is `undefined`, which also disables New through `newSessionWorkspace`, and pressing that Attach button calls `api.attach` on a ref the session manager no longer holds: `no such session`, a 404 into the error banner.
The only control on screen is one that can only fail.

The place to land already exists and needs no design.
`initialClientState()` returns `selected: null`, and the controller's initial view has `preview: null`, so `previewing` is false and the app renders the ordinary composer over an empty transcript, with its buttons disabled on `selected === null`.
That is where every user starts every session.

So: on a detach whose session was virtual, skip the preview and clear the selection, landing exactly there.
The non-virtual path is untouched -- it has a transcript to show and OW-tewave's whole point is that the user ends where a click on that row would have put them.

What is load-bearing is the unconditional `preview()` call, not the enablement decision and not the vanishing row.

Done when a controller test detaches a virtual selection and asserts `state.selected` and `preview` are both null afterwards, red first against today's `detach()`.

OW-tewave names a separate revisit for this case -- a `Discard` label when the selection is virtual, if the vanishing row ever surprises.
That is a labelling question and this card does not settle it.

## Close note

`detach()` in `src/client/controller.ts` no longer calls `controller.preview(selected)` unconditionally.
On a detach whose session had nothing on disk it bumps `selectionIntent`, publishes `selected: null` with `preview: null`, and returns -- the startup view, where `initialClientState()` puts every user anyway.
The non-virtual path is untouched and still previews, so the user ends where a click on the now-detached row would have put them (OW-tewave).
The bump is parity with the path it replaces: `preview()`'s first act is `++selectionIntent`.

One deliberate divergence from the card, confirmed at the source before landing.
The card and `detachable` tell a virtual session by `summaries[].status === "virtual"`, but that read is wrong inside `detach()` and not because of staleness: `#liveOverlay` in `src/server/http/session-manager.ts` returns `"attached"` whenever an adapter exists, regardless of `session.virtual`, and `session-manager.test.ts` "keeps virtual sessions out of the backend store until prompted (D9)" asserts status `attached` both before and after `markPrompted`.
So a session created in this client and detached before its first prompt -- the commonest way to reach this defect -- lists as `attached`, and a status-based guard would have left it broken.
The guard reads `selected.id.startsWith("virtual:")` instead.
That id is minted by `createVirtual` (`session-manager.ts`, `virtual:${this.#newId()}`) and the `renamed` reducer in `src/client/session-state.ts` rewrites `state.selected` onto the new ref the moment a first prompt materialises a file, so the prefix is true exactly while there is nothing on disk.
The reasoning sits in the comment at the branch.

Verified: a new controller test, "clears the selection onto the startup view when the detached session was virtual" in `src/client/controller.test.ts`, attaches a `virtual:` ref, detaches, and asserts `api.preview` was never called and that `state.selected`, `preview` and the live session entry are all gone.
Red first against today's `detach()` -- `expected "spy" to not be called at all, but actually been called 1 times, 1st spy call: [{ backend: "pi", id: "virtual:a" }]` -- and green after.
`bun run check` passes on main: 50 files, 1101 tests.
Landed as 8798519.

Not settled here, as the card said: OW-tewave's separate revisit of a `Discard` label for the virtual case is a labelling question and remains open.
Noticed and not done: the client now hard-codes the `"virtual:"` prefix, a server construct that is not part of the protocol contract in `src/shared/protocol.ts`; a shared `isVirtualRef` predicate would be its durable home if a second client-side caller ever appears.
