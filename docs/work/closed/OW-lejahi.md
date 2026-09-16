---
labels: [defect]
closed: done
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

## Close note

`detach()` in `src/client/controller.ts` now calls `void refreshSessions(false)` immediately after the deterministic live-view drop, above both of its exits.
It asks for the re-list rather than only riding the one the close broadcasts, so a Detach performed while the SSE is down no longer leaves the sidebar's attached stripe lit until the user presses Refresh.
Unawaited, for the same reason the view drop does not wait on the broadcast, and `false` because nobody asked for this listing -- it owns neither the status line nor the error slot, which is how the `sessions-changed` path already calls it.
It sits above both exits because the stripe is a property of the listing, not of which screen the user lands on; the virtual exit OW-vasubu added reaches it too.

Confirmed before landing that the unawaited call cannot clobber the exits' publishes: `refreshSessions` builds its state from `view.state` read at resolution time, not at call time, and its concurrent `refreshPreview` is a no-op while `view.preview` is null, which it is at that point.

Verified: a new controller test in `src/client/controller.test.ts`, "re-lists after a detach that no sessions-changed broadcast follows", attaches, points `listSessions` at a `detached` summary, detaches, emits no event at all, and asserts `state.summaries` is the detached one.
Red first -- `expected [ { …(7) } ] to deeply equal [ { …(7) } ]`, `- "status": "detached"` against `+ "status": "attached"`.
The virtual-detach test OW-vasubu added gained `expect(api.listSessions).toHaveBeenCalledTimes(2)` so the other exit is covered; that was red too, at 1 call.
`bun run check` passes on main: 50 files, 1102 tests.
Landed as a4f3857.

The wider question the card named -- whether `handlers.onOpen` should re-list on reconnect in general, which may be the better answer and would make this call redundant -- was deliberately not settled here and is filed as OW-vukoku, with the costs that make it a question rather than a defect.
