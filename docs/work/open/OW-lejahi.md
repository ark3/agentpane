---
labels: [defect]
---

# Detach leaves the attached stripe lit when the SSE connection is down

Found while reviewing OW-tewave.

The attached stripe is summary-only: `class:session-attached={summary.status === "attached"}` in `src/client/App.svelte`.
It flips only when a `sessions-changed` broadcast triggers `refreshSessions(false)`.
`controller.detach()` deliberately does not *wait* for that broadcast -- that is OW-tewave's design and it is right -- but it never asks for a re-list either, and `handlers.onOpen` does not re-list on reconnect.

So a Detach performed while the SSE is disconnected kills the agent and leaves the stripe lit until the user presses Refresh: the exact state OW-tewave was built to remove.
Detach is for a truthful indicator rather than for reclamation, which is what makes this worth more than its likelihood.

The obvious fix is a `void refreshSessions(false)` after the close resolves, alongside the deterministic view drop rather than instead of it -- but whether the reconnect path should re-list in general is the wider question and may be the better answer.

Done when a controller test detaches with no broadcast delivered and asserts the summary goes `detached` anyway -- red first against today's `detach()`.
