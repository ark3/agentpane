---
labels: [defect]
---

# A fork still broadcasts `renamed`, which tells every other browser the parent became the fork — and since OW-kekoji the server disagrees

Filed 2026-09-13 from the adversarial read of OW-kekoji, which changed the server's model of a fork's parent and left this one client-facing statement of the old model standing.

## What is still saying the old thing

`SessionManager.#adoptRef` in `src/server/http/session-manager.ts` ends with `this.broadcaster.renamed(from, next)`, and that line runs on the fork path as well as the two rename paths.
Since OW-kekoji the fork path no longer aliases the parent: the parent is detached, still on disk, and `list()` reports it again.
The broadcast says the opposite, to every connected browser rather than only the one that forked -- `Broadcaster` fans `renamed` out to all subscribers and follows it with a snapshot under the new ref.

What a browser does with it is in `src/client/session-state.ts`, the `if (event.type === "renamed")` arm:

- `delete sessions[fromKey]` discards the parent's `SessionView` -- its transcript, its `error`, its pending requests -- for a session the server now says still exists.
- the `summaries.map(...)` rewrites the parent's sidebar row into the fork's, in place. Not "fork added": parent replaced.
- `selected: sameRef(state.selected, event.from) ? event.session : state.selected` moves the selection onto the fork.

`src/client/App.svelte`'s `controller.onRename(...)` then re-keys that tab's follow-mode and turn-watch maps from parent to fork.

## The case that shows it

Two browsers on the same server.
Tab A forks a Pi or Claude Code session; tab B is sitting on the parent, reading it.
Tab B's selection jumps to the fork, a conversation nobody there opened; its parent transcript is dropped; its follow state moves with it.
The `sessionsChanged()` emitted one line earlier does drive a list refetch, so the parent's *row* returns to tab B's sidebar -- but the selection stays on the fork and the discarded `SessionView` is not rebuilt, so nothing repairs the half that matters.
Tab A sees a smaller version: the parent row vanishes and is replaced by the fork until its own refetch lands.

This is not a regression OW-kekoji introduced -- before it, tab B lost the parent outright and the server agreed.
It is the client half of the same defect, made visible because the server stopped agreeing.

## What it would cost to drop the broadcast on the fork path

Checked during the review, and reported as load-bearing for nothing:

- Selection onto the fork does not depend on it. `forkAndSubmit` in `src/client/controller.ts` attaches the fork itself and calls `applyAttached(attached, forkIntent === selectionIntent, forked)`, which is what sets `selected`.
- `forkAndSubmit`'s own `onRename` tracker updates a local `ref` that nothing reads after `api.fork`.
- `App.svelte`'s follow-mode arming has an explicit fallback -- `if (armedKey) rekeySession(armedKey, sessionKey(landed))` -- written for Codex, which never renames. It covers Pi and Claude Code too, just a beat later, at the prompt POST rather than at the fork.
- The broadcaster's per-key sequence carry-over is not needed: without it the fork's key starts at 0, the snapshot bumps it to 1, and the client has no view under that key to reject it.

So the choice is between dropping it for `cause === "fork"` and minting a `forked(parent, fork)` event that says what actually happened.
That decision is this card's substance and is not made here.
A `forked` event has a cost the drop does not: it is protocol, so `src/shared/protocol.ts`, the broadcaster, `session-state.ts` and the test SSE client at `src/server/http/testing/sse-client.ts` (which carries its own copy of the re-key logic) all move together.

## Done when

A test in `src/client/session-state.test.ts` or `src/server/http/` drives a ref-changing fork and asserts that a browser which did not do the forking keeps its selection and its parent `SessionView`.
It goes red first against today's behaviour.

`docs/WORKSTREAMS.md`'s client contract under "What the transport expects of its callers" is rewritten to match whichever way this goes; it currently carries a paragraph scoped to say that a fork's `renamed` breaks both of its promises, which exists only because this card was not yet worked.
