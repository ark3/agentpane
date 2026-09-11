---
labels: [defect, now]
closed: done
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

## Close note

Fixed in 935dcf2 on `main`.

`applyAttached`'s residual selection — which fires with `select: false` when `sessionKey(view.state.selected) === sessionKey(requested)` — now carries `preview: null` with it.
The gating is split: `error: null` stays on `select`, so OW-yasewo's silent `recover` keeps its hands off the error slot; `preview: null` is gated on the residual condition, named `takesSelection`.

What the wider preview gate does to `recover` is stated in the comment at the gating: nothing.
A session `recover` re-attaches is one this client already had attached, and an attached selection has no preview to clear (the `ControllerView.preview` invariant, "Null once the session is attached"), so the residual publishes a null that is already null.
That argument rests on the documented invariant rather than on a test; if the invariant ever loosens, the new gate would start clearing previews on a background recovery.

Verified: the new test in `src/client/controller.test.ts`, "clears the preview when the click it declined to overtake landed on the fork itself (OW-tatebi)", holds the fork's `api.attach` on a deferred, calls `controller.preview(forkedRef)` in that window, asserts the preview is non-null, then resolves the attach.
Run against the pre-fix `controller.ts` it was the only failure in the file (1 failed, 68 passed) at the `expect(preview).toBeNull()` line, with the stale preview object as the received value; the selection assertion passed even then, confirming the residual was firing and only the preview was left behind.
`bun run check` passes clean with the fix: 49 files, 1022 tests.
Not reproduced against a running backend, and no browser surface is touched, so `test:browser` was not run.
