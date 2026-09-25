---
labels: [deferral]
closed: done
---

# A Claude Code `init` that reports a session id other than the minted one swaps `currentRef` silently, and the manager never learns

OW-nikogo, filed 2026-09-24 under D24, closes this on the first of the two done-conditions below: the adapter's identity event is the fix this card already names.

`src/server/adapters/claude/adapter.ts`, the `init` handling that reads `session_id`: when it differs from the id the adapter minted, `currentRef` is replaced.
The docblock allows for this on purpose, "the CLI is authoritative".
But `SessionManager.#adoptRef` (`src/server/http/session-manager.ts`) re-keys only after `start()`, `submit()`, or `fork()` settle, and `init` arrives with the first turn, after `submit()` has already resolved.
The table therefore stays keyed by the minted id, the browser never receives a `renamed`, and the store file on disk carries the other id, which is the double-key condition `docs/WORKSTREAMS.md`, "What the Pi adapter expects of its caller", exists to prevent.

Deferred because every capture under `resources/fixtures/claude/` shows the CLI honouring `--session-id`, so the branch has never fired.
If it ever does, the fix is for the adapter to expose the change as an event the manager subscribes to, the way it already subscribes to `onUpdate`, rather than for the manager to poll `ref` at three points.
OW-yoyine's close note is the nearest prior art on Claude identity at hydration.

## Done when

Either a fixture shows the CLI diverging and the manager test proves the rename propagates, or the branch is replaced by a thrown error so the divergence can never be silent.

## Close note

Closed under OW-nikogo (2026-09-25), on the fix this card named: the adapter exposes the id change as an event the manager subscribes to.
`ClaudeAdapter.handleLine`'s `init` branch now calls `moveTo`, which fires `onRefChanged` as "rename" before that line's update and the reducer's effects, and the manager re-keys, aliases the old id and broadcasts `renamed` at once rather than at the next `submit()`/`fork()` settle.
No fixture shows the CLI diverging; the done-condition met is the manager test proving the rename propagates.
Tests: `src/server/http/session-manager.test.ts` "re-keys when Claude Code's init names another session after submit() resolved (OW-hikefi)", on the real `ClaudeAdapter` over `FakeClaudeProcess`, red before (no `renamed`), green after; `src/server/adapters/claude/adapter.test.ts` "announces the init's session id before that line's update and the reducer's effects".
