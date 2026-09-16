---
labels: [defect]
---

# A late SSE event can re-light the streaming dot on a session that was just detached

Found while reviewing OW-tewave, which added the Detach item that drops a session's live view from `view.state.sessions`.

`src/client/session-state.ts`: `reduceServerEvent` accepts any event for a key it does not know -- `acceptsSequence(undefined)` is true -- and recreates the entry through `emptySession`.
Events already on the wire when the server's `broadcaster.forget` ran can therefore land after the client has dropped the view, resurrecting it.

The transcript is safe: `previewing` in `src/client/App.svelte` gates on `view.preview`, so the pane stays read-only.
What is visible is the session list's per-row streaming dot, which reads `view.state.sessions[key]?.isStreaming ?? summary.isStreaming` -- a late `status` event re-lights it on a dead session until the next re-list cleans it through `replaceSessionSummaries`.

That is exactly the untruthful indicator OW-tewave exists to remove, which is the reason to file it; it is also self-healing on the next listing, which is the reason it was not fixed there.

Done when a client-state test feeds a `status` event for a key that is not in `sessions` and asserts it is ignored rather than resurrected -- red first -- and the session list no longer shows the dot in that window.
