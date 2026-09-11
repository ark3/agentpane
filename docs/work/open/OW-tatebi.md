---
labels: [defect, now]
---

# A fork the user clicked away from can leave a stale preview over the live transcript

Noticed by the implementer on OW-miyemo, 2026-09-10, and left undone there as out of that card's scope.
Read off `src/client/controller.ts`; not reproduced against a running backend.

`applyAttached(summary, select, requested)` gates both `error: null` and `preview: null` on `select`.
That gating is OW-yasewo's, written when `recover` was the only caller passing `false`.
D17 (OW-miyemo) added a second: a `forkAndSubmit` the user has clicked away from now passes `select: false` and still lands its attach and its prompt.

The gap is in `applyAttached`'s residual selection.
With `select: false` it still moves the selection when `sessionKey(view.state.selected) === sessionKey(requested)` — and `requested` is the fork's own ref.
So if the user's mid-fork click landed *on the fork itself*, which can happen once it has been listed, the selection moves onto the live attached ref as it should, but `preview: null` is not published alongside it.
The read-only preview the click opened stays on screen over a session that is now attached and streaming.

This is an edge of an edge: it needs the fork to be listed, and the user to click that specific row during the fork's own round trip.
It is filed rather than fixed because the obvious repair — publishing `preview: null` whenever the residual selection fires — changes `recover`'s behaviour too, and `recover` is the caller OW-yasewo deliberately made silent.

## Done when

A test in `src/client/controller.test.ts` drives a `forkAndSubmit` whose selection is overtaken by a click onto the fork's own ref, and asserts no stale preview survives the attach; it fails before the change.
And whatever the fix does to `recover`'s path is stated where the gating is, so OW-yasewo's reasoning is not quietly undone.

## Load-bearing

`applyAttached` is the only site.
Read its comment first: it names both `false` callers and why neither owns the error slot or the preview.
The question this card asks is narrower than that comment — not whether a declined-selection caller owns the preview, but what happens when the selection is *not* declined because the residual fired.
