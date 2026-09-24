---
labels: [defect]
closed: done
---

# A Codex warning naming a D19 subagent thread reaches no session

Found reviewing OW-tujiya, which surfaced Codex's `warning` and `guardianWarning` notifications as a per-session notice.

Both carry a `threadId` (`resources/codex-protocol/v2/WarningNotification.ts`, `v2/GuardianWarningNotification.ts`).
`CodexConnection` in `src/server/adapters/codex/connection.ts` hands every notification to every holder ("Notifications go to everyone and each reducer drops what is not its thread's"), and the guard at the top of `handleNotification` in `src/server/adapters/codex/reducer.ts` drops one whose `threadId` is not the reducer's own.
So a warning naming a subagent thread a D19 agent spawned -- a thread no holder drives -- is dropped by every reducer and reaches no session.
Blocking requests from such a thread are routed the other way on purpose: `#recipientFor` in `connection.ts` falls back to the first answerable holder.

## Decided

The owner decided on 2026-09-24 that such a warning is surfaced, not dropped, for OW-fomebu's reason: a dropped warning is one nobody can ever learn of.
It is routed the cheap way, which needs no reducer to track its thread's subagents: a `warning` or `guardianWarning` naming a thread that no holder on the connection drives is treated like a thread-less notice, and reaches every session on that app-server, as OW-tujiya routes those (the reason is at `CodexAdapter.onNotice` in `src/server/adapters/codex/adapter.ts`).
A warning naming a thread some holder drives still reaches that holder's session only.
Nobody has observed a subagent thread emit either notification, and no measurement is needed before building this.
Where the "no holder drives it" test lives -- `CodexConnection`, which knows its holders, or the reducers -- is incidental.

Done when the decision is written beside the guard in `reducer.ts` or beside `#recipientFor`, so the routing reads as chosen, and an adapter or connection test feeding a `warning` that names a thread no holder drives shows it reach every session on the connection, while one naming a held thread reaches only that session, red first.

## Close note

Built in 09af02a. `CodexConnection.#deliver` in `src/server/adapters/codex/connection.ts` now checks each `warning` or `guardianWarning` against the connection's holders. If none drives the thread it names, the warning goes to every holder with its `threadId` nulled, so each reducer surfaces it as a thread-less notice, the route OW-tujiya built. The reducer is unchanged.
A warning naming a held thread still reaches that session only, and every other notification (a subagent's turn and transcript stream included) is routed as before.
The decision is written beside `#deliver`, with pointers from the `case "warning"` comment in `reducer.ts` and the `CodexAdapter.onNotice` docblock in `adapter.ts`.

Verified by the adapter test "gives a warning naming a thread no session drives to every session on the connection (OW-weyefe)", beside the OW-tujiya routing test. It sends a `warning` and a `guardianWarning` for an unheld thread and shows both reach the parent and the fork's session. It also sends a `guardianWarning` for the fork's thread and shows it reaches the fork's session only.
The test went red against the original `connection.ts` (`expected [] to deeply equal [ Array(2) ]`) and green after the change. `bun run check` passes with 1303 tests.

An adversarial read found no behaviour defect.
It named two cases that the owner's rule covers literally, where the warning is broadcast rather than dropped:
- a closed fork whose turn is still running on the shared app-server;
- a notification naming a new fork's thread that arrives in the same stdout chunk as the `thread/fork` response, before the borrower has been adopted. This is theoretical: no Codex warning has been measured at fork time.

The comments call the unheld thread "usually" a subagent's for that reason.
