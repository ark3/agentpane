---
labels: [question]
---

# Should the SSE reconnect path re-list, so state missed while the connection was down heals on its own?

`src/client/controller.ts` -- `handlers.onOpen`, which today publishes `connection: "connected"` and nothing else, and `refreshSessions` a few hundred lines above it.

Raised by OW-lejahi and left open by it.
That card fixed one symptom of this: a Detach performed while the SSE was down killed the agent but left the sidebar's attached stripe lit, because the stripe reads `summary.status` and only a listing moves it.
The fix landed there is narrow and deliberate -- `detach()` now asks for its own `void refreshSessions(false)` rather than only riding the `sessions-changed` broadcast -- and OW-lejahi itself named the wider alternative as possibly the better answer.

The question this card holds is the general one.
Every other state change that happens while the connection is down still waits for the user to press Refresh; a detach is now self-healing and nothing else is.
Re-listing in `onOpen` would heal all of them at once and make the per-operation re-list OW-lejahi added redundant.

What makes it a question rather than a defect is that the costs are real and unmeasured.
`onOpen` fires on every reconnect, and a flapping connection would then list on every one; `refreshSessions` walks both backends' whole session stores, which D9 records as 973 files on the owner's machine.
`refreshSessions(false)` surfaces nothing, so a storm would be invisible rather than merely noisy, and `refreshInFlight` coalesces concurrent calls but not successive ones.
Reconnection also already delivers snapshots that carry per-session state, so what a listing adds is specifically the summary fields -- `status`, `cwd`, `updatedAt` -- and it is worth naming which of those actually go stale.

Load-bearing: the decision, not an implementation.
Incidental: whether OW-lejahi's call in `detach()` then comes back out -- that is a cleanup either way the decision goes.

Done when the decision is recorded where the next reader will look: in `docs/DESIGN.md` if it becomes a decision, or in the docblock at `handlers.onOpen` if the answer is no, saying why reconnection deliberately does not re-list.
If the answer is yes, this card also carries the change and closes on a controller test that reconnects with no broadcast and sees a freshened listing, red first.
