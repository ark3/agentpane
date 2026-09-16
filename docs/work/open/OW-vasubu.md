---
labels: [defect]
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
