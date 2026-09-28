---
labels: [defect]
---

# A listing that drops the selected session's live view leaves the browser's composer up, and since OW-sirofi its Send can only fail with 409 not_attached; the selection should fall back to a preview with the Attach button

Found 2026-09-28 by OW-sirofi's adversarial read; OW-sirofi made the failure visible, and the stale state is older.
In service of D25 in `docs/DESIGN.md`: only an attach starts an agent, and a session another client closes is, to this tab, a detached one to read and attach again, not a composer that sends.

## What happens

With the stream up, another client (a second tab, or agentpane-mode's `agentpane-close-session`) closes session S while S is selected here.
The server's `sessions-changed` makes this tab re-list, and `replaceSessionSummaries` in `src/client/session-state.ts` deletes S's live view from `state.sessions`, but leaves `state.selected` on S and `view.preview` null.
`src/client/App.svelte` draws the Attach button only while `previewing` (`const previewing = $derived(view.preview !== null)`), so the composer form stays up over an empty transcript.
A Send there reaches `api.prompt(selected, ...)` in the controller's `submit` (`src/client/controller.ts`), and since OW-sirofi the prompt route refuses it: 409 `not_attached`, shown as "session ... is not attached".
Before OW-sirofi the route attached first and the send respawned S, which D25 withdrew.
Edit (which fetches `api.forkPoints` first), the model and effort selectors, and Compact reach the same refusal.

## The change

When a listing evicts the selected session's live view, the selection ends where `detach()` in `src/client/controller.ts` leaves a detached session: its preview fetched and shown, so the pane offers the Attach button and no composer that sends.
A view the listing evicts that is not selected needs nothing new.
OW-fiheli carries the same end state for a stream drop, where the server is down and a preview fetch fails; here the server is up and the preview is the point.
Where the eviction runs -- `replaceSessionSummaries` is a pure state function, and the preview fetch is the controller's -- is the implementer's call; what is load-bearing is that no path leaves a selected session with neither a live view nor a preview.

## Done when

A test in `src/client/controller.test.ts`, red first, holds S attached and selected, answers a re-list with S `detached`, and asserts S's view is gone, `view.preview` holds S's turns, and the controller sends no prompt for S (a `submit` issues no `api.prompt`).
A sibling of "forgets a cached live session when a fresh listing reports it detached" in that file is the place to start.
`bun run check` passes, and `bun run test:browser` too if the composer's action row or `App.svelte` changes, per `AGENTS.md`.
