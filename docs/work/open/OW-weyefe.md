---
labels: [question]
---

# A Codex warning naming a D19 subagent thread reaches no session

Found reviewing OW-tujiya, which surfaced Codex's `warning` and `guardianWarning` notifications as a per-session notice.

Both carry a `threadId` (`resources/codex-protocol/v2/WarningNotification.ts`, `v2/GuardianWarningNotification.ts`).
`CodexConnection` in `src/server/adapters/codex/connection.ts` hands every notification to every holder ("Notifications go to everyone and each reducer drops what is not its thread's"), and the guard at the top of `handleNotification` in `src/server/adapters/codex/reducer.ts` drops one whose `threadId` is not the reducer's own.
So a warning naming a subagent thread a D19 agent spawned -- a thread no holder drives -- is dropped by every reducer and reaches no session.
Blocking requests from such a thread are routed the other way on purpose: `#recipientFor` in the same file falls back to the first answerable holder.

The decision is whether a subagent thread's warning should reach the session whose thread spawned it, as its requests do, or stay unsurfaced, and either answer is recorded at the guard or at `#recipientFor` so the asymmetry reads as chosen.
Nobody has observed a subagent thread emit either notification; whether one can, as of the installed `codex-cli`, is part of what the decider may want measured first.
Routing it would need the reducer to know its thread's subagents, which the reducer does not track today.

Done when that decision is written beside the guard in `reducer.ts` or beside `#recipientFor`, and, if the answer is to route it, a reducer or adapter test feeding a subagent-thread `warning` shows it reach the parent's session, red first.
