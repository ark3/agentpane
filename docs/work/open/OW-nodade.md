---
labels: [deferral]
---

# The browser's foldSessionTurns never drops a key the live session map no longer carries, so its streaming and finished tables grow for the life of the tab

Noticed by OW-wazipa's implementer on 2026-09-27, which fixed the Emacs client's counterpart: `agentpane--note-turns` in `emacs/agentpane.el` now drops from both finished-turn tables every handle its unfiltered listing no longer carries.
The browser keeps the same state in `SessionTurnMarks` (`src/client/session-turns.ts`), folded by `foldSessionTurns` from `App.svelte`'s live streaming map ("sessionTurnMarks = foldSessionTurns(" in `src/client/App.svelte`).
The fold only adds and updates keys from the map it is given; nothing removes a key the map stopped carrying, so a handle the server let go of stays in `streaming`, and in `finished` if it was marked, until the tab reloads.
Handles are never reused (`#handlePrefix` in `SessionManager`, `src/server/http/session-manager.ts`), so a stale key is never drawn; the cost is memory only, and unlike Emacs nothing re-checks each mark on every window change, which is why this is a deferral.
Under the "Both clients" rule in AGENTS.md this is internal housekeeping, not a user-facing capability, so it does not need to land in both clients together.

Confirm first whether the map `App.svelte` passes carries every live session, as the Emacs listing does; dropping absent keys is only right if absence means let go.
Done when a vitest case in `src/client/session-turns.test.ts` folds a map without a key previously observed and asserts the key is gone from both tables — red before, green after — or when it is declined in the `foldSessionTurns` docblock with the reason.
