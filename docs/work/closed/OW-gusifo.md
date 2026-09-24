---
labels: [change, emacs]
closed: done
---

# A request that stops being pending stays held by the server and drawn in both clients, because nothing retracts it

Rewritten 2026-09-24 from a cold read against the code as it stood after OW-bipume.
Until then this card also carried declining at arrival the requests nothing can answer (D2a, OW-yikoyo); that half is now OW-zisumi, blocked by this one, because declining honestly needs the retraction this card builds.

Since OW-bipume the server holds each session's pending requests (`ManagedSession.requests` in `src/server/http/session-manager.ts`, beside `#pendingRequests`, which maps a request id to its session for routing), every `snapshot` carries them, and each client replaces its own list from the snapshot.
Between snapshots nothing removes one: the `ServerEvent` union in `src/shared/protocol.ts` has `request` and no event that retracts it, and the `request` arm of `reduceServerEvent` in `src/client/session-state.ts` only appends.

A request stops being pending in one of three ways, and today:

- **Answered through the reply route** (the reply case of `sessionAction` in `src/server/http/app.ts` calls `adapter.reply`, then `SessionManager.clearRequest`): it leaves both of the manager's maps and so the next snapshot, but no event says so, and the browser's warning and Emacs's line stand until something else sends a snapshot.
- **Reported resolved by Codex** (`serverRequest/resolved`, which `CodexReducer` turns into a `request-resolved` effect, consumed by the `"request-resolved"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts`): the adapter clears its own maps and tells the manager nothing, so the server holds the request for good, every snapshot re-sends it, and not even a reload clears the warning or re-enables Tools -> Detach (`detachable` in `src/client/App.svelte`).
- **Answered by the adapter itself**: OW-nujawi's arrival error answers before publishing, so that one never lands; OW-zisumi will add kinds that are published and then declined at once.

Two facts the surrounding comments get wrong, read from the fixture and the source on 2026-09-24:

- The only `serverRequest/resolved` ever captured, in `resources/fixtures/codex/tool-edit.jsonl` (`codex-cli 0.147.0`), follows the capture harness's own answer to the request.
  Codex resolving a request without us -- "auto-approval, or another client", as the comments beside `request-resolved` in `src/server/adapters/codex/reducer.ts` and `adapter.ts`, and D2a's paragraph "A resolved request has no wire event" in `docs/DESIGN.md`, all put it -- has never been observed.
  Mark every copy unmeasured in the same change.
- A subagent thread's request is routed to the parent session (`#deliver` in `src/server/adapters/codex/connection.ts`, OW-futewo), but its `serverRequest/resolved` names the child's `threadId` (`resources/codex-protocol/v2/ServerRequestResolvedNotification.ts`), and the guard at the top of `handleNotification` in `reducer.ts` drops a notification naming a thread other than its own.
  So a retraction resting on that notification alone never fires for such a request.

In service of the browser's warning ("The agent is blocked on a request agentpane cannot answer"), Emacs's `⚠` line for a request, and the Detach gate saying what is true.
Load-bearing:

- A request that stops being pending, by any of the three ways, leaves the manager's `requests` and `#pendingRequests` and is retracted live on the wire.
- That includes a request a subagent thread raised through the parent.
- A client that missed the retraction converges on the next snapshot, which already carries the held list.
- Both clients act on it.
  In Emacs, the helper's `switch` on `event.type` in `src/emacs/helper.ts` has no default and would drop a new variant silently, and `emacs/agentpane.el` appends a `(:request ...)` node on `session/request` and removes one only when a `session/snapshot` redraws the buffer; the helper answering a retraction with a fresh `session/snapshot` is enough if it keeps that side small.
  The `src/emacs/protocol.ts` docblock that says a request is carried "until it is answered" is brought in line either way.

Incidental: whether the retraction is its own `ServerEvent` variant (it takes a `seq`, as `request` does) or a field on another, and the name of the adapter hook that carries it out -- `BackendAdapter` in `src/server/adapters/types.ts` has `onRequest` and `reply`, and `src/server/http/testing/fakes.ts` holds the fake adapter the manager's tests drive.

Codex is the only backend that detects a resolution; Pi's dialog requests are OW-yosuzo's, and Claude Code raises none.

## Done when

- A test in `src/server/http/session-manager.test.ts`, modelled on "drops a request once it is answered", has the fake adapter raise a request and then report it resolved, and asserts a retraction on the wire and an empty `requests` on the next snapshot, red first.
- The same file asserts that the reply route's clear broadcasts a retraction too.
- A test in `src/server/adapters/codex/adapter.test.ts` asserts that `serverRequest/resolved` for a published request reaches the new hook under the id it was published with, including for a child-thread request routed as in "identifies a child-thread blocking request and routes it through the parent (OW-futewo)", red first.
- A test in `src/client/session-state.test.ts` asserts a retraction removes the request from `view.requests`.
- A test in `src/emacs/helper.test.ts` and one in `emacs/agentpane-test.el` show the transcript buffer losing the request's line on a retraction, each red first.
- D2a's paragraph "A resolved request has no wire event" says the gap is closed.
- `bun run check` and the ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, both pass.

## Close note

Landed in dc06746.
A new `request-resolved` ServerEvent (`src/shared/protocol.ts`), sent by `Broadcaster.requestResolved`, retracts a request however it stopped being pending.
`SessionManager.clearRequest` removes the request from `requests` and `#pendingRequests` and broadcasts the event, whether the reply route calls it or the new optional `BackendAdapter.onRequestResolved` hook does; `#start` subscribes that hook.
The Codex adapter fires the hook on `serverRequest/resolved`, under the id it published the request with, and only for a request `reply` has not already answered.
The Codex reducer now reads `serverRequest/resolved` ahead of its thread guard.
That way a subagent thread's request, which is routed to the parent (OW-futewo), is retracted too: only the adapter that published the wire id maps it.
Clients: `reduceServerEvent` drops the request from `view.requests`; the Emacs helper forwards the event as `session/requestResolved`, and `agentpane--drop-request` in `emacs/agentpane.el` removes that request's line.
OW-zisumi can fire `onRequestResolved` from an adapter that declines a request itself.
The claim "auto-approval, or another client" is now marked unmeasured in all three places it appeared: `reducer.ts`, `adapter.ts` and D2a.
D2a's paragraph now opens "A request that stops being pending is retracted on the wire".
Verified with new tests in session-manager.test.ts (the adapter-resolved path and the reply route), adapter.test.ts (same-thread and child-thread), session-state.test.ts, helper.test.ts and agentpane-test.el.
The implementer saw each new test fail first.
The dispatching session reproduced the failures of the child-thread adapter test (reducer change reverted) and the ERT test (agentpane.el reverted).
`bun run check` passes (1348 tests), and so does the ERT suite (93).
