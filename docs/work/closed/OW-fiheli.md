---
labels: [change, d25]
closed: done
---

# A browser tab whose event stream drops keeps every live view, so after a server restart it shows sessions as attached until a listing evicts them one by one; a drop should detach them all at once

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first.

## What happens

`onDisconnect` in `src/client/controller.ts` publishes `connection: "reconnecting"` and nothing else, so every live view in `view.state.sessions` stands through the outage.
On the reconnect, `onOpen` asks for a listing (D21), and `replaceSessionSummaries` in `src/client/session-state.ts` evicts a view only where a listed summary pairs with it by ref and says `detached`.
A restarted server holds nothing, so after a restart every view is wrong until that pairing catches it, and the pairing misses cases: OW-keleti, closed moot into this card, is a view whose ref a rename moved while the stream was down, which no summary pairs with.

## The change

When the stream drops, the tab holds nothing live: every view in `view.state.sessions` goes at once, with the per-tab state `src/client/App.svelte` keeps under a view's handle (the favicon badge's turn watch, follow, remembered scroll), as a detach of each would leave it.
Agentpane is local-only, and on both machines it runs on a stream drops only when the server exits, so D25 takes a drop to mean every agent is gone; there is no restart announcement and nothing in the UI says a restart happened.
The selected session ends where `detach()` in the controller leaves a detached session, but mind that the server is down at that moment, so a preview fetch fails; the load-bearing part is that the pane offers no composer that sends while nothing is attached, and that the user can read the transcript again once the server is back, by clicking the row.
Whether the transcript stays on screen through the outage is incidental.
The reconnect's listing (D21) and the server's opening snapshots stay as they are: after a drop the server survived, those snapshots re-introduce every session still live, which is correct, since it is still live.

## Done when

A test in `src/client/controller.test.ts`, red first, holds two live views with one selected, fires the stream's disconnect, and asserts `view.state.sessions` is empty and the selected session offers no send (whatever state the controller exposes for that).
A test there shows that the opening snapshot of a reconnect re-introduces a view for a session the server still holds.
`bun run check` passes.
If the change touches the composer's action row or `App.svelte`'s follow-mode scrolling, `bun run test:browser` passes too, per `AGENTS.md`.

## Close note

Built on 2026-09-28 in two commits on main, both "(OW-fiheli)".
`onDisconnect` in `src/client/controller.ts`, fatal or not, now publishes in one go: `sessions: {}`; every summary the server held flipped to `status: "detached", isStreaming: false` (the sidebar's stripe and streaming dot read summaries until the reconnect listing), except rows with nothing on disk, which are removed as at `detach()`'s no-disk exit; each row keeps its `handle`, which is what `followRef` pairs a reconnect's opening snapshot by after a rename.
The selection is cleared unless a preview is on screen, since a preview cannot be fetched with the server down; the end state is `detach()`'s startup view, `submit()` refuses locally, and clicking the row previews it once the server answers. A preview of a removed no-disk row is cleared too.
`selectionIntent` is deliberately not bumped (a bump would strand `busy` on "attaching"); the in-flight-attach race that leaves is filed as OW-wazija.
`App.svelte`'s startup auto-select waits out `connection: "reconnecting"`, so it no longer fires a preview at a dead server whose failure outlived the outage.
Because the reconnect publishes `connected` before its opening snapshots, `preview()` now re-checks `viewOf` when its fetch resolves and reselects the live session rather than landing a preview over it.
The reconnect's listing (D21) and opening snapshots are unchanged.
Verified: new tests in `src/client/controller.test.ts` (drop, fatal and not: views empty, rows detached, selection null, no `api.prompt`; a preview survives a drop; a no-disk previewed row is cleared; an opening snapshot re-introduces a view, including under a renamed ref by handle; a preview fetch overtaken by a snapshot lands live) and `src/client/App.test.ts` (no auto-select while reconnecting), each shown red first; `bun run check` (1476 tests) and `bun run test:browser` (26/26) green on main.
Found by the adversarial read and filed: OW-wazija, an attach/create/fork whose reply lands after the drop re-selects a live session with no view.
