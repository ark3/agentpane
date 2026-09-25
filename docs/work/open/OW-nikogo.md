---
labels: [change, d24]
---

# An adapter announces its identity change as an event and the manager re-keys on it, in place of re-reading `ref` after start, submit and fork

Filed 2026-09-24 under D24 in `docs/DESIGN.md`, the first half of its identity commitment; read that decision first.
In service of the manager never holding a container under a name its adapter has already left.

## What happens today

`BackendAdapter.ref` in `src/server/adapters/types.ts` is a getter, and `PiAdapter`'s docblock on `ref` (`src/server/adapters/pi/process.ts`) tells the server to "re-read `adapter.ref` after `start()` and after the first `submit()` resolves".
`SessionManager` in `src/server/http/session-manager.ts` does that at three points, named in `#adoptRef`'s and `fork()`'s docblocks: after `adapter.start()` in `#start`, and in the `finally` of `submit()` and of `fork()`.
Every identity change lands between the adapter's move and the manager's next look.

- OW-zovaye: `PiAdapter.fork` moves `sessionRef` and then `hydrateMessages()` emits the fork's rewound transcript, still inside `session.adapter.fork()`, under the container's parent ref.
  Closed with a `forking` count on the container and the guard in `#onUpdate` that drops the update.
- OW-nuzepi, open: the same window on the pull path, the lambda `setSnapshotSource` is given, an attach of the parent from another client and a new stream's opening snapshots, and in `onRequest` and `onError`, which key by `session.ref` too.
- OW-hikefi, open: the `init` branch of `ClaudeAdapter.handleLine` (`src/server/adapters/claude/adapter.ts`) replaces `currentRef` when the CLI names another session id, after `submit()` resolved, so the manager never learns; its body already names the fix, "for the adapter to expose the change as an event the manager subscribes to, the way it already subscribes to `onUpdate`, rather than for the manager to poll `ref` at three points".

## What this card does

The contract gains an event on every adapter, `onRefChanged(cb: (ref: SessionRef, cause: "rename" | "fork") => void): Unsubscribe`, fired synchronously at the moment the adapter's `ref` changes and before the adapter emits anything else under the new ref.
The FROZEN INTERFACE note at the top of `types.ts` asks for a change to be raised first; D24 is that raise, and the note is amended to cite it.
Where each adapter fires it:

- Pi: `adoptSessionFile` with cause "rename", at `start()`'s `get_state` and in `submit()` for a Pi that named none at start; `fork()` with cause "fork", right after the `get_state` that names the moved file and before the re-sent model and level and `hydrateMessages()`.
- Codex: `start()` where `currentRef` takes `started.thread.id`, cause "rename", which also covers a fork at the first user message, whose placeholder ref is renamed at attach (OW-hojefo).
  `startBorrowed` fires nothing, since `adoptConnection` seeded the fork's id at construction and `thread/resume` answers it, and a Codex fork fires nothing on the parent (OW-22; the Codex-shaped case in `session-manager.test.ts`).
- Claude Code: `start()` where `currentRef` takes the minted or resumed id, and the `init` branch of `handleLine`, both "rename"; `fork()` runs nothing and fires nothing (OW-razoki).

`SessionManager.#start` subscribes to it before `adapter.start()`, beside `onUpdate`, and the handler is what re-keys: its "rename" branch does what `#adoptRef(session, "rename")` does today and its "fork" branch what `#adoptRef(session, "fork")` does, and the three polling call sites go.
So do `forking` and the `#onUpdate` guard OW-zovaye added: the container is under the fork's ref before `hydrateMessages()` emits, and an update under the fork's ref reaches no client view, as the non-creating arms of `reduceServerEvent` guarantee (OW-pezazo).
The clients' rename tracking, and the `session/renamed` the helper synthesizes in `sessions/attach` (`src/emacs/helper.ts`), are untouched here; OW-suyinu and the cards behind it are where the clients stop tracking renames.

Load-bearing:

- A fork is not a rename, and the cause keeps the split OW-kekoji, OW-suhoto and OW-sehaja settled: "fork" writes no alias, broadcasts no `renamed`, clears `stored`, `onDisk` and `error`, stamps `createdAt`, and leaves the parent detached; "rename" aliases and broadcasts.
  The blocks "an adapter that renames itself (the Pi contract)" and "fork (the third #adoptRef point)" in `session-manager.test.ts` pin both and stay green; the tests under "what the adapter emits from inside a ref-changing fork (OW-zovaye)" stay green with the counter gone; `src/server/http/vertical-slice.test.ts` "leaves a browser that did not fork on the parent it was reading (OW-suhoto)" stays green.
- Teardown still wins: `close()` and `disposeAll()` set `torndown` before their first await and `#adoptRef` checks it first (OW-yavewa, OW-jimasu); the event handler checks the same flag, so an event from an adapter whose container was closed mid-fork re-keys nothing.
- The event fires before any `onUpdate`, `onRequest`, `onError` or `onNotice` under the new ref, in every adapter.
- Nothing moves the parent's ref on a Codex or Claude Code fork, and nothing disturbs a Codex or Claude Code parent's live turn (D15, OW-ziyobe).

## Done when

- OW-nuzepi's test, in `src/server/http/session-manager.test.ts`: an adapter that moves its ref and rewinds its state inside `fork()`, while the fork is held, and the parent's snapshot read through the snapshot source and through `liveRefs()` shows no rewound transcript under the parent's ref, and an `onRequest` or `onError` raised in the same window goes out under the fork's ref; red before the change.
  OW-nuzepi closes under this card.
- OW-hikefi's, in the same file: a Claude-shaped fake whose `init` renames the session after `submit()` resolved, and the manager broadcasts `renamed` and honours both ids; red before the change.
  OW-hikefi closes under this card on the first of its two done-conditions.
- A test per adapter, in `src/server/adapters/pi/process.test.ts`, `src/server/adapters/codex/adapter.test.ts` and `src/server/adapters/claude/adapter.test.ts`, that the event fires before the first update under the new ref.
- `bun run check` green.
- Before this card is executed the dispatching session runs a cold read at it, a dry-run executor and an adversarial auditor before any code is written, and amends the card with what they find; this and OW-suyinu are the two cards in the `d24` stream large enough to need one.
