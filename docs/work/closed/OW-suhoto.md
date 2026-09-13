---
labels: [defect]
closed: done
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

## Close note

Fixed by dropping the broadcast on the fork path: `#adoptRef` in `src/server/http/session-manager.ts` now ends `if (cause === "rename") this.broadcaster.renamed(from, next)`, with `sessionsChanged()` still firing unconditionally (69d80c1).

The card left a choice open between that drop and minting a `forked(parent, fork)` event. The drop won: `src/shared/protocol.ts` is frozen under D11, and a `forked` event would have had no consumer that needed it — `sessionsChanged()` already invalidates every browser's list, and the forking browser's own selection comes from `applyAttached` in `forkAndSubmit`, not from any event. Each of the four "load-bearing for nothing" claims the card listed was re-checked at the source and held; in particular `Broadcaster.renamed`'s seq carry-over is now reached only by real renames, and leaving the parent's seq entry alone on a fork is the more correct outcome since the parent still exists and browsers still hold views at that seq.

Verified by `src/server/http/vertical-slice.test.ts`, "leaves a browser that did not fork on the parent it was reading (OW-suhoto)": a real app over a Pi-shaped fake adapter, one `SseTestClient` standing in for the browser that did not fork, its events fed through the real `reduceServerEvent` with `selected` seeded to the parent. It asserts the onlooker keeps `selected === parent` and the parent's two-message transcript, holds no view under the fork's key, and receives no `renamed`. Shown red twice — once by the implementer, once again by the dispatching session re-breaking the one-line change — and it goes red on `expect(state.selected).toEqual(parent)` receiving the fork's id, which is the defect itself rather than merely the event's absence.

`src/server/http/session-manager.test.ts`'s Pi-style fork test kept its re-keying assertions (`forked` equals the moved ref, `liveRefs()` is the moved ref alone) and flipped only its `renamed` expectation to `[]`.

Retired every copy of the old claim, not just the docs: `docs/WORKSTREAMS.md`'s client contract under "What the transport expects of its callers" (the fork paragraph is gone, replaced by "A fork never emits it, on any backend"), the `fork()` and `#adoptRef` docblocks in `session-manager.ts`, the fork route's Pi bullet in `src/server/http/app.ts`, `forkAndSubmit`'s comment in `src/client/controller.ts`, and the follow-mode `rekeySession` fallback comment in `src/client/App.svelte` — which had said Pi's fork renames and Codex's does not, and now says no fork does, so that fallback is the path for both. The surviving `renamed` mentions in `protocol.ts`, `app.ts:242`, `docs/DESIGN.md` and `docs/HANDOFF.md` are all about the D9 materialisation rename and stay true. The WORKSTREAMS line also carried a second error worth recording: it said a fork on "Pi or Claude Code" emits `renamed`, but Claude Code takes Codex's path with its own ref unchanged (OW-razoki), so Pi was always the only backend reaching that path.

`bun run check` green (49 files, 1051 tests, 21s). `bun run test:browser` not run and not required: no scrolling, `app.css`, composer, message-footer or `public/` code is touched, and the one `App.svelte` edit is a comment.
