---
labels: [change, d25]
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
