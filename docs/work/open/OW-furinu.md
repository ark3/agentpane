---
labels: [defect]
---

# The session list only reflects a turn after a manual Refresh: the streaming dot and the recency order both read a snapshot that live events never update.

Reported by the owner 2026-08-27: the streaming dot does not appear or clear when it should, the list does not reorder as sessions become active, and pressing Refresh does both at once.
Refresh is the tell — the button that OW-65 added for sessions created *outside* the app is doing the work of the live event stream.

## One cause behind both symptoms

The list renders from `view.state.summaries`, a snapshot of the last list read, and nothing but a re-list ever changes it.

The row's dot is `{#if summary.isStreaming}` (`src/client/App.svelte`, in the session `<nav>` beside `.session-backend`), and the order is `sortedSummaries`, which sorts on `recency(summary)` — `updatedAt ?? createdAt` from `src/client/time.ts`.
Both fields therefore date from the last `api.listSessions`.

Live turn activity never causes one.
`reduceServerEvent` (`src/client/session-state.ts`) returns `refreshSessions: true` for exactly one event, `sessions-changed`; the `status` event's whole effect is `view.isStreaming = event.isStreaming` on `state.sessions[key]`, which is the live map the transcript reads and the list does not.
On the server, `broadcaster.sessionsChanged()` is called from five places in `src/server/http/session-manager.ts` — create, attach, rename, `markPrompted`, and close — all lifecycle, none of them a turn boundary.
The streaming flip is already computed one function away, at `streamingChanged` in the same file, and emits `broadcaster.status(...)` only.

So the summary's `isStreaming` is right at the instant it is read and never again.
The server does overlay it correctly at read time — `#liveOverlay` in `session-manager.ts`, which is why the disk readers can hardcode `isStreaming: false` (`src/server/sessions/{pi,codex,claude}.ts`) and why `src/server/http/deps.ts` says the field from disk is ignored.
Nothing is wrong with the read; there is simply no event that repeats it.

One case does work, and it is worth knowing before you try to reproduce: the *first* prompt to a virtual session hits `markPrompted`, which does emit `sessions-changed`.
A first turn therefore relists and looks live. Second and subsequent turns do not.

## The constraint that makes this non-obvious

Do not fix this by making the sort depend on live state.
OW-jineli (closed) deliberately put a `summaries` derived between `view` and `sortedSummaries` so the sort is invalidated by the *array*, not by every publish: measured against a production build at 400 sessions, `recency` was 8-15% of per-event self time, and the corpus is ~973 sessions per D9.
Read that card before touching `App.svelte:142-151`; its docblock is at the site and says the same thing.
A fix that re-sorts per streaming token trades this defect for that one.

Turn boundaries are the escape: they are two events per turn, not one per token.

## Intent

The list should show a session as streaming while it streams, and should move to the top when it becomes active, without anyone pressing Refresh.
Refresh should go back to being what OW-65 built it for — catching sessions created outside the app.
This card does not remove the button.

Two seams look right, and the split matters because the two symptoms are not equally cheap:

- **The dot** does not need a re-list at all. `state.sessions[key].isStreaming` is already live and already correct; the row can prefer it over the summary's copy when the session is in that map. A per-row lookup does not touch `sortedSummaries` and so does not disturb OW-jineli.
- **The order** does need fresh `updatedAt`, which only a re-list carries. Emitting `sessions-changed` where `streamingChanged` is already computed would relist at both ends of every turn. Confirm before building that `updatedAt` has actually moved by the time the relist reads it — it comes from the backend's own file, so a relist fired at turn start may read a timestamp the backend has not yet written, in which case the reorder lands on the turn's end and not its start.

Either seam is open to a better one; what is load-bearing is that no fix may re-sort per token.

## Done

`bun run check` passes, and both symptoms have a test that fails first.

For the dot, in `src/client/App.test.ts`: render a list whose summary says `isStreaming: false` while `state.sessions` holds that same ref streaming, and assert the row shows the streaming indicator — the existing test "shows a streaming indicator only for a session that is streaming" is the pattern, and `nav.queryByLabelText("Streaming")` is the handle.
Cover the clear direction too, since a dot that latches on is the same defect wearing the other sign.

For the order, drive the real controller with a fake api the way `src/client/controller.test.ts` already does for the `sessions-changed` path around its "listSessions" coalescing test: assert a turn boundary causes the re-list that the snapshot-only path does not.
If the fix is server-side, `src/server/http/session-manager.ts`'s tests are where the emit belongs, asserted through the broadcaster.

Both are jsdom- and node-visible; `bun run test:browser` is not implicated.
Confirm the whole thing by hand in `bun run dev` with two sessions, prompting the one that is not selected — the dot should light and the row should rise with no Refresh.
