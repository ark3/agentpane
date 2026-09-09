---
labels: [deferral]
---

# A Claude Code `init` that reports a session id other than the minted one swaps `currentRef` silently, and the manager never learns

`src/server/adapters/claude/adapter.ts`, the `init` handling that reads `session_id`: when it differs from the id the adapter minted, `currentRef` is replaced.
The docblock allows for this on purpose, "the CLI is authoritative".
But `SessionManager.#adoptRef` (`src/server/http/session-manager.ts`) re-keys only after `start()`, `submit()`, or `fork()` settle, and `init` arrives with the first turn, after `submit()` has already resolved.
The table therefore stays keyed by the minted id, the browser never receives a `renamed`, and the store file on disk carries the other id, which is the double-key condition `docs/WORKSTREAMS.md`, "What the Pi adapter expects of its caller", exists to prevent.

Deferred because every capture under `resources/fixtures/claude/` shows the CLI honouring `--session-id`, so the branch has never fired.
If it ever does, the fix is for the adapter to expose the change as an event the manager subscribes to, the way it already subscribes to `onUpdate`, rather than for the manager to poll `ref` at three points.
OW-yoyine's close note is the nearest prior art on Claude identity at hydration.

## Done when

Either a fixture shows the CLI diverging and the manager test proves the rename propagates, or the branch is replaced by a thrown error so the divergence can never be silent.
