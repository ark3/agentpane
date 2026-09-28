---
labels: [change, d25]
---

# The browser stores the pane's preview beside the selection and infers live from its absence, so paths that add or drop a view leave a composer over nothing or a preview over a live session; the pane's mode should be derived

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, section "What the run found, and the two ownership changes it asked for", which the owner took that day; read it first.
OW-zivamo, OW-wazija and OW-tefigi closed moot into this card; each names an ordering its test must cover, and all three are worth reading for the paths they traced.

## What happens

`src/client/App.svelte` picks what the pane shows from one stored field: `const previewing = $derived(view.preview !== null)`.
With a preview it draws the read-only transcript and the Attach button; without one it draws the composer over `viewOf(view.state, view.state.selected)`, which may not exist.
So the absence of a preview is read as "live", and every controller path in `src/client/controller.ts` that adds or drops a view keeps the pairing by hand: `applyAttached` clears the preview, `preview()` re-checks through `reselectLive`, `detachGapped` fetches a preview under its `still()`, `onDisconnect` works out whether to keep it, and `detach()` has its own exit.
A listing that evicts a view through `replaceSessionSummaries` in `src/client/session-state.ts` keeps nothing, and a snapshot that introduces a view in `onEvent` consults nothing.
The results: a composer over no view, whose Send can only meet `409 not_attached` (OW-zivamo's listing eviction, OW-wazija's attach reply after a stream drop, OW-tefigi's attach reply after a gap dropped the view its snapshot made), and a preview left standing over a live view, with the live view's banners above it (OW-tefigi's second ordering).

## The change

The pane's mode is derived, with a fixed precedence, from what the tab holds for the selected session:

- **live** when the tab holds a live view of it: the transcript and the composer, and only here; a stored preview is ignored.
- **preview** when it holds no view and a preview of that session is stored: the read-only transcript and the Attach button.
- **detached, loading** when it holds neither: the Attach button, no composer, and an empty pane.
  The owner chose the empty pane on 2026-09-28 over keeping the last live transcript on screen: it says honestly that something is going on.

One function derives it, and both `App.svelte` and the controller read it; `submit`, and the other verbs that reach a live session, act only in the live mode, so the controller cannot send without a view whatever the UI draws.
One place fetches the preview: whenever the mode is detached-loading, the stream is `connected`, and no fetch for that ref is in flight.
That replaces the per-path fetches in `detachGapped` and `detach()`, and waits out the server being down after a drop, which OW-fiheli left to a failing fetch.
A session with nothing on disk still leaves the selection, as `detach()`'s no-disk exit does today; where that decision lives is this card's call.
The attach reply stops writing the row's `status` into the sidebar through `replaceSummary`; the listing owns `status`, as it does for every other row, so a reply that lands after a drop cannot mark a row attached (OW-wazija).
Check what else reads that write before removing it, and say in the commit what you found.
Once the derivation and the one fetch owner stand, the per-path pairing checks named above go; the commit names each one kept and what it still guards.

## Done when

Tests in `src/client/controller.test.ts`, each red first on the code as it stands:

- OW-zivamo's ordering: S attached and selected, a re-list answering S `detached`; the mode is not live, `submit()` issues no `api.prompt`, and S's preview is fetched and shown.
- OW-wazija's ordering: `select` with `api.attach` held, the stream dropped, the attach resolved; the mode is not live, no summary reads `attached`, and `view.busy` is back to `"idle"`; the same through `create` and `forkAndSubmit`.
- OW-tefigi's first ordering: the attach's snapshot lands, a gap drops the view, then the reply lands; the mode is detached-loading, not a composer over nothing.
- OW-tefigi's second ordering: a preview on screen, then a snapshot introducing a live view of that session; the mode is live.
- A stream drop leaves the selected session detached-loading with no fetch sent, and the fetch goes out once the stream reports `connected`.

A test on `App.svelte` shows the Attach button and no composer in the detached-loading mode.
`bun run check` passes, and `bun run test:browser` passes, since this changes what the composer's action row draws (`AGENTS.md`).
