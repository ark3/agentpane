---
labels: [defect]
---

# A Codex warning naming a D19 subagent thread reaches no session

Found reviewing OW-tujiya, which surfaced Codex's `warning` and `guardianWarning` notifications as a per-session notice.

Both carry a `threadId` (`resources/codex-protocol/v2/WarningNotification.ts`, `v2/GuardianWarningNotification.ts`).
`CodexConnection` in `src/server/adapters/codex/connection.ts` hands every notification to every holder ("Notifications go to everyone and each reducer drops what is not its thread's"), and the guard at the top of `handleNotification` in `src/server/adapters/codex/reducer.ts` drops one whose `threadId` is not the reducer's own.
So a warning naming a subagent thread a D19 agent spawned -- a thread no holder drives -- is dropped by every reducer and reaches no session.
Blocking requests from such a thread are routed the other way on purpose: `#recipientFor` in the same file falls back to the first answerable holder.

## Decided

The owner decided on 2026-09-24 that such a warning is surfaced, not dropped, for OW-fomebu's reason: a dropped warning is one nobody can ever learn of.
It is routed the cheap way, which needs no reducer to track its thread's subagents: a `warning` or `guardianWarning` naming a thread that no holder on the connection drives is treated like a thread-less notice, and reaches every session on that app-server, as OW-tujiya routes those (the reason is at `CodexAdapter.onNotice` in `src/server/adapters/codex/adapter.ts`).
A warning naming a thread some holder drives still reaches that holder's session only.
Nobody has observed a subagent thread emit either notification, and no measurement is needed before building this.
Where the "no holder drives it" test lives -- `CodexConnection`, which knows its holders, or the reducers -- is incidental.

Done when the decision is written beside the guard in `reducer.ts` or beside `#recipientFor`, so the routing reads as chosen, and an adapter or connection test feeding a `warning` that names a thread no holder drives shows it reach every session on the connection, while one naming a held thread reaches only that session, red first.
