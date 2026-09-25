---
labels: [change, d24]
closed: done
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
It fires only when the id actually changes: several assignments set the id the adapter already holds (Codex `startBorrowed`, `adoptConnection` and `start` on a resume, Claude `start` on a resume), and those fire nothing.
The FROZEN INTERFACE note at the top of `types.ts` asks for a change to be raised first; D24 is that raise, and the note is amended to cite it.
Where each adapter fires it:

- Pi: `adoptSessionFile` with cause "rename", at `start()`'s `get_state` and in `submit()` for a Pi that named none at start; `fork()` with cause "fork", right after the `get_state` that names the moved file and before the re-sent model and level and `hydrateMessages()`.
  The `fork` response names no file (`src/server/adapters/pi/protocol.ts`), so the adapter learns the move only from that `get_state`; anything Pi emitted between the two would still go out under the parent, and as of `pi 0.87.1` nothing did (OW-dutute, `docs/MANUAL_TESTING.md`).
- Codex: `start()` where `currentRef` takes `started.thread.id`, cause "rename", which also covers a fork at the first user message, whose placeholder ref is renamed at attach (OW-hojefo).
  `startBorrowed`, `adoptConnection` (reached from a Codex `fork()` and from `start()` on the OW-voyezi path) and a resume set the id already held and fire nothing, and a Codex fork fires nothing on the parent (OW-22; the Codex-shaped case in `session-manager.test.ts`).
- Claude Code: `start()` where `currentRef` takes the minted id, and the `init` branch of `handleLine`, both "rename"; `fork()` runs nothing and fires nothing (OW-razoki).

`SessionManager.#start` subscribes to it before `adapter.start()`, beside `onUpdate` and in `bound.subscriptions`, and the handler is what re-keys: its "rename" branch does what `#adoptRef(session, "rename")` does today and its "fork" branch what `#adoptRef(session, "fork")` does, with the new ref passed in rather than read from `session.adapter`.
The polling in the `finally` of `submit()` and `fork()` goes.
So do `forking` and the `#onUpdate` guard OW-zovaye added: the container is under the fork's ref before `hydrateMessages()` emits.

A rename announced inside `start()` is not re-keyed in the handler.
All three adapters rename there (Pi at `start()`'s `get_state`, Codex at `started.thread.id`, Claude synchronously at the minted id), and at that moment `bound.adapter` is unset and `#attaching` holds the startup only under the requested and canonical keys, so re-keying then would let a `close()` under the new name miss `pending.torndown` and leak the child, let an `attach` of the new name start a second adapter on the same container, and leave aliases a failed start cannot clean up (the comment beginning "Publish the adapter *before* the rename below").
The handler records such a ref in a variable local to that `#start` call -- never on `ManagedSession`, which outlives a failed start and would hand a retry a rename its new adapter never announced -- and `#start` applies it where it adopts today, right after `bound.adapter = adapter`.
Nothing reads the container before that point: the snapshot source and `liveRefs()` both pass over a container with no adapter, and nobody can name the new id before it is published.
A start that fails therefore never renames, as today.
OW-suyinu, which keys the container by a handle that never changes, is where this deferral dissolves.
D24's "the three polling points go" in `docs/DESIGN.md` is amended to say so.

The handler checks no `torndown` flag.
`close()` and `disposeAll()` drop `session.subscriptions` in the same synchronous run that sets `ManagedSession.torndown`, so an event can never reach a handler of a torn-down container, and a check on the flag there is a guard nothing can execute.
With the polling in the `finally` gone, `#adoptRef`'s check is that field's only reader, so `ManagedSession.torndown` is retired and unsubscription is the invariant, stated where the flag was; D24's "teardown's `torndown` flag stops an event-driven re-key as it stops the polled one" is amended to match.
`PendingStart.torndown` is a different field and stays.

The clients' rename tracking, and the `session/renamed` the helper synthesizes in `sessions/attach` (`src/emacs/helper.ts`), are untouched here; OW-suyinu and the cards behind it are where the clients stop tracking renames.

### What changes that is not a defect

- A Pi fork's hydrate now reaches every client as a snapshot under the fork's ref, and the snapshot arm of `reduceServerEvent` creates a view for it (`src/client/session-state.ts`), so this card's filing claim that the non-creating arms keep it out of every view was wrong.
  It is harmless: the forking client's attach of the fork takes `attach`'s existing-adapter branch and broadcasts the same snapshot to every client anyway.
  When the fork changed only the model, level or `unrestoredModel` and the parent was idle, `#onUpdate` sends a `status` alone and the rewound messages wait for that attach.
- Between the event and the hydrate, the fork's ref reads the parent's un-rewound transcript, streaming flag included, which is OW-nuzepi's mirror image and heals at the hydrate or the attach; accepted, not guarded.
- Once the event has re-keyed a Pi fork's container, a route on the parent's ref misses `#lookup`: `attach` spawns a fresh parent from the index instead of queuing onto the fork, `abort` answers 404, and `close(parent)` no longer disposes the fork.
  Each matches the parent being detached (OW-kekoji, D20).
  A second Pi process on the parent's file at that point is safe on the evidence: the event follows the `fork` response, and as of `pi 0.87.1` the abandoned turn's last events all preceded that response and a `--session` resume of the abandoned file read it whole (OW-dutute).
  A verb sent before the event still runs on the fork, since `#serially` takes the container at call time, so D24's "a verb sent on a Pi parent's ref and queued behind its fork runs on the fork" stays true with a narrower window; say so there and in `#serially`'s docblock.

Load-bearing:

- A fork is not a rename, and the cause keeps the split OW-kekoji, OW-suhoto and OW-sehaja settled: "fork" writes no alias, broadcasts no `renamed`, clears `stored`, `onDisk` and `error`, stamps `createdAt`, and leaves the parent detached; "rename" aliases and broadcasts.
  The blocks "an adapter that renames itself (the Pi contract)" and "fork (the third #adoptRef point)" in `session-manager.test.ts` pin both and stay green, the second renamed now that there are no polling points.
- Under "what the adapter emits from inside a ref-changing fork (OW-zovaye)", the first two tests stay green with the counter gone, and two are rewritten to what the event makes true.
  "sends nothing under the first fork's ref while a second fork of it is in flight" asserts `under(moved, events)` is empty, which the first fork's own hydrate now breaks by going out under `moved`; it becomes an assertion that nothing the *second* fork emits goes out under `moved`.
  "still broadcasts under the container's ref when the adapter's ref runs ahead with no fork in flight" pins the OW-hikefi lag this card abolishes; it becomes `renamed` followed by the upsert under the new ref, or folds into OW-hikefi's test.
  Neither rewrite may bring back a guard in `#onUpdate`.
- `src/server/http/vertical-slice.test.ts` "leaves a browser that did not fork on the parent it was reading (OW-suhoto)" stays green, but its `expect(state.sessions[sessionKey(fork)]).toBeUndefined()` holds only because `FakeAdapter.fork` emits nothing, and against real Pi the hydrate creates that view; its load-bearing assertions are the selection staying on the parent, the parent's transcript untouched and no `renamed`.
  Leave the test as it is unless the change makes it red.
- `FakeAdapter` in `src/server/http/testing/fakes.ts` fires the event from `materialiseAs` (called directly by tests and by `materialiseOnStart` and `materialiseOnSubmit`) and from its "pi"-mode `fork`, and `dispose()` clears the new listener set as it clears the others; without that nearly every manager rename and fork test stops re-keying.
- The event fires before any `onUpdate`, `onRequest`, `onError` or `onNotice` under the new ref, in every adapter.
- Nothing moves the parent's ref on a Codex or Claude Code fork, and nothing disturbs a Codex or Claude Code parent's live turn (D15, OW-ziyobe).

### Copies of the polling contract to retire in the same change

`AGENTS.md`, "When a run overturns a fact the repo already recorded", asks for every copy; the cold read on 2026-09-25 found these, and grepping `re-read`, `#adoptRef`, `forking`, `third #adoptRef` and `two points at which` finds any it missed.

- `src/server/http/session-manager.ts`: the docblocks of `submit()`, `fork()`, `#adoptRef`, `ManagedSession.torndown` and `#serially`; "`#start`'s call site is guarded by `pending.torndown`; these two are guarded here"; "The first of the two points at which the id can change (D9)"; the "Before the first await below, so a `submit()`/`fork()` already in flight cannot re-key" comments in `close()` and `disposeAll()`; the comment beginning "Publish the adapter *before* the rename below" stays true under the deferral and is reworded at most.
- `src/server/adapters/pi/process.ts`: the `ref` docblock's "re-read `adapter.ref` after `start()` and after the first `submit()` resolves", and "Awaited, because the manager reads `ref` the moment `submit()` settles".
- `src/server/adapters/codex/adapter.ts`, the comment above `startBorrowed`'s assignment; `src/server/adapters/claude/adapter.ts`, the module docblock and the `ref` docblock.
- `src/server/http/app.ts`: "`submit()` is one of the two points at which a session's id changes under us (D9)", and the fork route's commentary on the re-key.
- `src/client/session-state.ts`, the `renamed` arm's commentary on when the server renames; `src/server/http/testing/fakes.ts`, the `materialiseAs` docblock and the header's account of the polling.
- `src/emacs/agentpane.el`, the comment saying the server drops what `PiAdapter.fork' emits before `SessionManager.fork' re-keys (OW-zovaye); `src/emacs/helper.ts`'s rename synthesis stays true.
- Test comments in `src/server/http/session-manager.test.ts`: the Pi-contract block's opening, "fork (the third #adoptRef point)", the OW-zovaye describe's opening ("before the manager's `finally` re-keys"), and the OW-yavewa and OW-jimasu tests' "`fork`'s `finally` reaches `#adoptRef`".
- `docs/DESIGN.md`: "so the manager hears of such a move only at the next point it re-reads `ref`" under D9, and D24 as above; `docs/WORKSTREAMS.md`, the bullet "**Re-read `adapter.ref` after `start()` and after the first `submit()`.**" and what follows it.

## Done when

- OW-nuzepi's test, in `src/server/http/session-manager.test.ts`: an adapter that moves its ref and rewinds its state inside `fork()`, held after the move (the existing `attachRewindingOnFork` gates only before it), and the parent's snapshot read through `broadcaster.sendSnapshot` or `sendOpeningSnapshots(client, sessions.liveRefs())` shows no rewound transcript under the parent's ref, and an `onRequest` or `onError` raised in the same window goes out under the fork's ref; red before the change.
  Not through `sessions.attach(REF)`, which after the change spawns a fresh parent from the index.
  OW-nuzepi closes under this card.
- OW-hikefi's, in the same file: a Claude-shaped adapter whose `init` renames the session after `submit()` resolved -- the real `ClaudeAdapter` over `FakeClaudeProcess`, which that file already imports, or a fake -- and the manager broadcasts `renamed` and honours both ids; red before the change.
  OW-hikefi closes under this card on the first of its two done-conditions.
- A test per adapter, in `src/server/adapters/pi/process.test.ts`, `src/server/adapters/codex/adapter.test.ts` and `src/server/adapters/claude/adapter.test.ts`.
  On Pi, the fork's event fires before the `setModel` re-send's and the hydrate's updates; on Claude, the `init` event fires before that line's `emitUpdate` and the reducer's effects.
  On Codex, where the id change is `start()`'s last statement and nothing can follow it inside start, the test is that a fresh start fires "rename" once and a resume, `startBorrowed` and a fork fire nothing.
- A manager test that a rename announced during a held `start()` is applied only after the adapter is published, and one that a start failing after such a rename leaves no rename, no alias and no `renamed` behind.
- `bun run check` green.
- Cold read done 2026-09-25, a dry-run executor and an adversarial auditor, and this body amended with what they found; the deferral of a start-time rename and the retirement of `ManagedSession.torndown` came out of it.

## Close note

Landed on main 2026-09-25.
Every `BackendAdapter` has `onRefChanged(ref, cause)`, fired synchronously through a per-adapter `moveTo` only when the id actually changes and before anything else it emits under the new id: Pi at `adoptSessionFile` ("rename") and right after the fork's `get_state` ("fork"), Codex at a fresh start's `thread/start` id, Claude at the minted id and at an `init` naming another; resumes, Codex's borrower paths and Codex and Claude forks are silent.
`SessionManager` re-keys in the handler through `#adoptRef(session, next, cause)`; the polling in `submit()`'s and `fork()`'s `finally`, OW-zovaye's `forking` count and `#onUpdate` guard, and `ManagedSession.torndown` are gone.
Two decisions came out of the cold read (a dry-run executor and an adversarial auditor): a rename announced inside `start()` is held in a `#start`-local `renamedInStart` and applied after `bound.adapter = adapter`, since `#attaching` holds a startup under the requested and canonical keys alone, and OW-suyinu now carries retiring that wait; and teardown's invariant is `close()`/`disposeAll()` unsubscribing in the same synchronous run that takes the container out, since a handler-side `torndown` check could never execute.
Review found the OW-yavewa/OW-jimasu teardown tests vacuous under the change, because `FakeAdapter.dispose()` clears listeners; they now dispose as `PiAdapter` does and go red without the unsubscription.
Verified: OW-nuzepi's and OW-hikefi's manager tests red before and green after; per-adapter ordering tests red when the fire site is moved late; start-time tests red against a handler that re-keys immediately; the finished-work adversarial read mutated each and saw red; `bun run check` green, 1383 tests.
D24 and D9 in `docs/DESIGN.md` and `docs/WORKSTREAMS.md` record it as landed.
Left alone: `CodexAdapter` and `PiAdapter` dispose without clearing `refListeners`, harmless since the manager unsubscribes.
