---
labels: [defect]
closed: done
---

# A Pi fork broadcasts the fork's rewound snapshot under the parent's ref, so a client showing the parent redraws it shortened

Found by the adversarial read of OW-fojike, 2026-09-22, from the code and a probe of the real `SessionManager` and `Broadcaster` with a fake adapter forking in `PiAdapter.fork`'s order; not yet run against a live `pi`.
In service of a Pi fork leaving its parent's view as it was, in every client.

`PiAdapter.fork` in `src/server/adapters/pi/process.ts` moves `sessionRef` onto the fork's file and then calls `hydrateMessages()`, whose `emitUpdate(undefined)` fires synchronously with the rewound messages.
That is inside `session.adapter.fork(entryId)` in `SessionManager.fork` (`src/server/http/session-manager.ts`), before its `finally` runs `#adoptRef(session, "fork")`, so the manager broadcasts that snapshot under `session.ref`, still the parent's.
Any client holding the parent receives the fork's shortened transcript as the parent's: the Emacs helper forwards it as `session/snapshot` because the parent's key is still in its `attached` set (`src/emacs/helper.ts`, `onEvent`), and the browser's per-session state keyed by the parent takes it too.

OW-fojike worked around it in `emacs/agentpane.el`: after a Pi fork the parent buffer redraws from the store (see `agentpane-fork`'s docstring).
Once this is fixed that redraw is redundant, and whoever fixes it should say so there or remove it.

Done when a `session-manager` test with an adapter that emits during `fork()` after moving its ref sees no snapshot broadcast under the parent's ref carrying the rewound transcript, red before the fix.

## Close note

Landed on main as 94a266f and bfd6b90.

- `SessionManager` (`src/server/http/session-manager.ts`) keeps a `forking` count per container, raised around `adapter.fork()` and lowered in its `finally` before `#adoptRef`; `#onUpdate` drops an update while a fork is in flight and the adapter's ref has moved off the container's, since it describes the fork while `session.ref` still names the parent.
  Dropped, not deferred: no client holds the fork yet, and the forking client's attach snapshots it.
  A count, not a flag, so a second concurrent fork keeps the window shut; the fork condition keeps renames (a Claude `system init` id change) broadcasting under the old ref as before.
- The Emacs workaround is gone: `agentpane--fork-at`'s Pi branch no longer redraws the parent from the store, only detaches it, and `agentpane-fork`'s docstring no longer describes the ordering as current.
  The browser's `forkAndSubmit` had no workaround; its parent state now simply keeps its live transcript.

Verified: `bun run check` 1179 tests and ert 43/43 on Emacs 31.1; the three new `session-manager` fork tests were red against the old code (a snapshot under the parent's ref carrying only the rewound message), the concurrent-fork test red with a boolean flag, the rename test red with the fork condition removed, and the renamed Emacs test `agentpane-test-pi-fork-leaves-the-parent-as-it-was` red against the old redraw.
Not run against a live `pi`.

Filed from it: OW-nuzepi, the same symptom through the snapshot source (an attach or an opening stream during the fork) and `onRequest`/`onError` in the same gap.
