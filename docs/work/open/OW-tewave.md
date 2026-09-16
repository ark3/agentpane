---
labels: [change]
---

# The Tools menu gets a Detach item that closes the selected session's subprocess and leaves its transcript on screen read-only

`src/client/App.svelte` (the Tools popover and `compactSession`), `src/client/controller.ts`, `src/client/api.ts`, `src/client/session-state.ts`, `src/server/http/app.ts` (`sessionRoute`), `src/server/http/session-manager.ts` (`close()`), `docs/DESIGN.md` D12, OW-33, OW-35.

The owner asked for this on 2026-09-16: a conversation that is well and truly done keeps its attached stripe in the session list (OW-lepoki) for the life of the server process, and that stripe is a distraction once nothing more will happen there.
The want is a truthful indicator, not resource management.
That distinction matters because D12 recorded, in OW-33's paragraph beginning "Why D12 exists, and why it is not urgent", that a detach button was proposed on 2026-08-15 and the idle reaper plus the LRU cap were the answer to it, since managing subprocess lifetime by hand is what D12 refuses.
The reaper is still unbuilt, which is why attached rows pile up today, and the owner's answer on 2026-09-16 is that the two are not exclusive: a reaper clears the stripe fifteen minutes after the last activity, and this item clears it when the user decides the conversation is done.
The item is deliberately in the Tools popover, which holds the rare things (OW-relehi), not beside Send.

## What already exists

Everything server-side.
`DELETE` on the session route calls `close()`, which disposes the adapter, drops the session from the table, keeps its on-disk summary, and broadcasts `sessionsChanged()`.
Read `close()`'s docblock for the Codex share rule, which it already handles.
Nothing in the client calls that route, and the client `api` has no method for it.

OW-fihuma (closed) is the prior art on the client side: after a close from elsewhere, the re-list that `sessions-changed` triggers makes `replaceSessionSummaries` in `src/client/session-state.ts` forget the live view of a session now reported detached.
It loads no preview, so the transcript pane of a session closed under you goes empty today.
The composer draws the live view when `selectedSession` exists and the preview otherwise, and with neither it draws nothing.

## What to build

- `api.close(ref)`: `DELETE` to `ROUTES.session(ref)` through `requestNoContent`, the shape `compact` already has in `src/client/api.ts`.
- `controller.detach()`: close the selected session, then drop its live view and load its read-only preview, so the user ends where a click on that row would.
  Do not wait for the broadcast re-list to drop the view: the re-list is asynchronous, and `preview()`'s shortcut at "A session already attached in this client keeps its live transcript" would keep the dead view if it ran first.
  Drop the view deterministically after the close resolves, then fetch the preview.
- A `Detach` menuitem in the Tools popover after Compact, hiding the popover the way `compactSession` does and for the reason its docblock gives.

## Enablement

Enabled only when the selected session is attached or virtual, is not streaming, holds no pending request (`selectedSession.requests`), and no prompt POST is in flight (`view.sending`, since the turn it starts is not yet streaming).
This is the reaper's exemption predicate from D12, "Two triggers, one predicate", reused, minus the virtual exemption; the owner chose it on 2026-09-16.
Streaming comes from the live `state.sessions` entry, as the list row reads it (OW-furinu), not from the summary.
The why: `close()` kills mid-turn, and on Claude Code a kill mid-turn loses the whole reply (OW-japuzo).

Virtual sessions are enabled by the owner's decision on 2026-09-16.
A virtual session is a workspace choice with nothing on disk, per `createVirtual`'s docblock in `session-manager.ts`, so there is no transcript to lose, and D12's third exemption was about a reaper silently removing a session the user had just created, which a deliberate click is not.
The consequence to know: `list()` is disk plus the table, so closing a virtual session removes its row entirely rather than flipping it to detached.
The label stays `Detach` for that case as a first cut; if the vanishing row ever surprises, a `Discard` label when the selection is virtual is the revisit.

## Docs to retire in the same change

Three copies of the claim that no client control invokes the route, all of which this card makes false:

- `docs/DESIGN.md` D12, the parenthetical beginning "There is no explicit "end session" control in the UI to retire".
  Rewrite it to record this item and the owner's 2026-09-16 reasoning, and keep the sentence that the route stays.
- OW-33, "which is why no such button exists".
- OW-35, "there is no end-session button in the UI today".

The `app.css` comment above `.session-attached` saying attached is unbounded stays true until the reaper lands and is not a copy of this claim.

## Prompting after a detach

The prompt route in `app.ts` attaches before submitting, so the server side of re-prompting a detached session already works.
This item is the first UI path that reaches OW-35's scenario without restarting the server.
Whatever the implementer observes when prompting a session just detached from this menu, record it in OW-35.

## Done when

1. `src/client/api.test.ts` asserts `close` issues `DELETE` to the session route and resolves on no content; sibling of "attaches a session and unwraps its summary".
2. `src/client/controller.test.ts` asserts `detach()` on the selected attached session calls the API's close, then the session is gone from `state.sessions`, its preview is fetched and shown, and `isStreaming` is false, whether the broadcast re-list lands before or after the preview; sibling of "forgets a cached live session when a fresh listing reports it detached".
3. `src/client/App.test.ts` asserts the Tools menu holds a `Detach` menuitem that is disabled with nothing selected, while streaming, and with a pending request, enabled for an attached and for a virtual selection, and that clicking it invokes the controller's detach; siblings of "disables the composer's New conversation and Compact when nothing is selected (OW-72)" and "the composer's Compact tool compacts the selected session (OW-72)".
4. Each test is shown red against the unmodified source first.
5. `rg -n 'end.session|no such button' docs/DESIGN.md docs/work -g '!*tewave*'` finds no copy of the retired claim.
   This card quotes the three copies in order to name them, so it matches itself and is excluded; every other match is a copy that has to go.
6. `bun run check` passes, and `bun run test:browser` has been run by hand before the commit, as `AGENTS.md` requires for a change to the composer's action row.
