---
labels: [defect]
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
