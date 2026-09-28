---
labels: [change, d25]
closed: done
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
That replaces the per-path fetches in `detachGapped` and `detach()`, and waits out the server being down after a drop, where OW-fiheli's `onDisconnect` instead clears the selection unless a preview is on screen, because the preview could not be fetched with the server down.
So a drop now keeps a selection whose session is on disk, and the fifth test below requires it.
A session the server has let go of with nothing on disk still leaves the selection, as `detach()`'s no-disk exit and `onDisconnect`'s no-disk rows do today; where that decision lives is this card's call.
It is not "nothing on disk" alone: `detachGapped` deliberately previews a no-disk session, because after a gap the server still holds it and the empty preview's Attach reaches it (OW-vasubu, and the test "lands a gapped selection with nothing on disk on its preview (OW-lunihe)").
Nor can a failed fetch be the signal: per `detach()`'s docblock, `readSessionPreview` answers a gone no-disk ref with an empty but non-null transcript rather than an error.
The attach reply stops writing the row's `status` into the sidebar through `replaceSummary`; the listing owns `status`, as it does for every other row, so a reply that lands after a drop cannot mark a row attached (OW-wazija).
Only the `status` goes: `replaceSummary` swaps in the reply's whole summary, and its `handle` is load-bearing — `handleOf` falls back to it in the window before the snapshot, and `followRef` pairs a renamed snapshot through it (the test "updates selection from the snapshot that introduces a session under a ref its attach reply did not name").
A created or forked session has no listed row whose `status` could be kept; what its new row reads until the listing arrives is this card's call, bounded by the wazija test's "no summary reads `attached`".
`replaceSummary` has two callers, `applyAttached` and `attachAndSelect`'s superseded-reply branch, and the rule covers both.
Readers of `status` found at filing, for the check below: the sidebar's stripe and aria-label, `detachable` in `App.svelte`, `onDisconnect`'s flip, and `replaceSessionSummaries` keeping the current row over a stale listing (OW-fihuma).
Check what else reads that write before removing it, and say in the commit what you found.
Once the derivation and the one fetch owner stand, the per-path pairing checks named above go; the commit names each one kept and what it still guards.

## Settled at execution, 2026-09-28

A cold read of this card against `main` at 97b8e47 found the calls below left open; they are settled here so the implementer does not have to guess.

- **Nothing selected is not one of the three modes.**
  With `state.selected === null` the pane stays as it is today: the composer, whose `submit` answers "Select a session before submitting a prompt."
  The precedence above covers a selected session only, and roughly twenty `App.test.ts` tests render that startup view.
- **The attach reply can beat its snapshot (D2), and that window is detached-loading.**
  The state cannot tell it from OW-tefigi's first ordering, so no `attaching` flag suppresses it: the Attach button over an empty pane for that instant is accepted, and matches why the owner chose the empty pane.
  The one owner may fetch a preview in that window; a preview landing once the view exists is ignored by precedence, and nothing else may act on it.
- **Which verbs act only in the live mode:** `submit`, `compact`, `abort` and `forkAndSubmit`, each checked at its entry.
  `forkAndSubmit`'s own prompt to the fork is not gated, since the fork's snapshot usually lands after that prompt goes.
  `detach` is not gated: after a gap the server still holds the session with no view in this tab, and Detach closes it.
  `setModel`, `setEffort` and `clearError` already need a view.
- **The one fetch owner is evaluated from `publish`**, the controller's one chokepoint, so no path can forget it.
  Like `detachGapped` today it writes neither `busy` nor `error` nor the intent.
  Its preview lands only if the selection still names that session and the mode there is still detached-loading.
  A failed fetch does not re-arm on its own, which would be a hot loop against a server answering an error: it falls to the startup view, reporting nothing, as `detachGapped`'s failure branch does today (the test "leaves a gapped selection on the startup view when its preview cannot be read").
  A gap still owes the rename it carried: the reducer returns on a gap before `followRef` moves the selection, so the selection has to reach the gapped event's `ref` for the owner to fetch the right one (the test "previews the ref a gapped event renamed the session to (OW-lunihe)").
- **The preview poll runs only in the preview mode.**
  `syncPoll` and `refetchPreview` key on `view.preview` alone today, so a stored preview beside a live view would keep being polled.
- **`attachSelected` in `App.svelte` reads `view.preview?.ref`** and returns without one, so the detached-loading mode's Attach button would do nothing; it has to attach the selection.
- **Browser only, by design.**
  agentpane-mode's side of the same follow-up is OW-rebawa; `src/emacs/` imports `session-state.ts`'s reducer and types but not `controller.ts`, so keep `ClientState` and `reduceServerEvent` as they are, or check `src/emacs/helper.ts` if they move.

Expect churn beyond the five new tests: the cold read counted about 25 controller tests that call a live verb without ever emitting a snapshot, the OW-lunihe gap tests and the detach tests that see `api.preview` without `api.open()` (`FakeApi.connect` never fires `onOpen`), the drop test that asserts `selected` is null, and the tests pinning each per-path check this card retires.
Each such test is rewritten to the new contract, not deleted to make the suite green.
The docblocks that describe the stored pairing go stale in the same change and are rewritten with it: `ControllerView.preview`, `onDisconnect`, `detach()`, `detachGapped`, `preview()`, `syncPoll`, `refetchPreview`, and in `App.svelte` the auto-select comment and `detachSession`'s.

## Done when

Tests in `src/client/controller.test.ts`, each red first on the code as it stands:

- OW-zivamo's ordering: S attached and selected, a re-list answering S `detached`; the mode is not live, `submit()` issues no `api.prompt`, and S's preview is fetched and shown.
- OW-wazija's ordering: `select` with `api.attach` held, the stream dropped, the attach resolved; the mode is not live, no summary reads `attached`, and `view.busy` is back to `"idle"`; the same through `create` and `forkAndSubmit`.
- OW-tefigi's first ordering: the attach's snapshot lands, a gap drops the view, then the reply lands; the mode is detached-loading, not a composer over nothing.
- OW-tefigi's second ordering: a preview on screen, then a snapshot introducing a live view of that session; the mode is live.
- A stream drop leaves the selected session detached-loading with no fetch sent, and the fetch goes out once the stream reports `connected`.

A test on `App.svelte` shows the Attach button and no composer in the detached-loading mode.
`bun run check` passes, and `bun run test:browser` passes, since this changes what the composer's action row draws (`AGENTS.md`).

## Close note

Built 2026-09-28 in three commits on `main`: "derive the pane's mode from what the tab holds, and fetch a detached pane's preview in one place", "ask again for a detached pane's preview whose read the stream dropped under", and "retire compact()'s no-view branches and the prose the live gate made false", all (OW-forinu).

`paneMode(view)` in `src/client/controller.ts` derives live / preview / loading (null with nothing selected, which keeps the startup composer); `App.svelte` draws from it, and `submit`, `compact`, `abort` and `forkAndSubmit` act only on `live`.
`publish` drops any stored preview the mode does not show and calls `loadPreview`, the one fetch owner, which reads the preview while the pane is loading and the stream is `connected`, keyed by `previewLoads`; a failed read falls to the startup view, except one the stream dropped under, which is asked again once per drop through a `streamDrops` counter.
The poll runs only in the preview mode.
An attach reply keeps the listed row's `status` (`replaceSummary`), a row no listing has named reading `detached`; `onDisconnect` keys its no-disk rule on `onDisk` for that reason and keeps an on-disk selection across a drop.
Removed: `applyAttached`'s and `reselectLive`'s preview clears, `detachGapped`'s own fetch (it now only drops the view and moves the selection to the gapped event's ref), `onDisconnect`'s keep-only-with-a-preview rule, and `detach()`'s trailing `preview()`; kept: `detach()`'s and `onDisconnect`'s no-disk exits, and `preview()`'s re-check, for the live selection's model list.

Before the work, a cold read found the card's calls left open, and they were settled in the card's "Settled at execution" section (commit "amend OW-forinu with the calls its cold read found open").
Verified: each of the five done-condition tests in `src/client/controller.test.ts` and the App test "draws the Attach button and no composer over an empty pane for a selection with neither a view nor a preview" ran red on the old code, first with a stub `paneMode` and again with the mode assertions stripped; `bun run check` passed (1492 tests) and `bun run test:browser` passed (26) on `main` after the cherry-pick.
About 25 controller tests and 2 App tests were rewritten to emit a snapshot or open the stream before their live verbs; none were deleted.

The adversarial read proved four residuals by probe, filed as OW-sabova (a coalesced listing now leaves a live row reading `detached` and Detach disabled, a regression), OW-lejape (a no-disk session let go outside `detach()` and `onDisconnect` lands on the empty preview), OW-bilogo (replace `loadPreview`'s failed-read rule and its `streamDrops` counter, which miss a read failing before the drop is heard or before an attach's snapshot, and a hung read), and OW-didose (Attach does not focus the prompt when the reply beats its snapshot).
