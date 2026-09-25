---
labels: [defect]
closed: done
---

# A Codex re-attach can drop deltas for an item that started before it attached

OW-dutute, filed 2026-09-24 under D24, closes this: the test below is its Codex half's done-condition, and the measurement it asks for is made there.

Found while landing OW-vijuyi on 2026-09-24; read from the code, never run.

This is the half of OW-vijuyi's problem its fix does not reach.
OW-vijuyi made `CodexReducer.hydrate` (`src/server/adapters/codex/reducer.ts`) keep the slots the live stream built during a re-attach, so an item whose `item/started` arrives after `CodexAdapter.adoptConnection` survives the history paging.
An item whose `item/started` came before the attach has no slot until `hydrate` runs, and `applyDelta` drops a delta with no slot (`slotFor` returns undefined).
So every `item/agentMessage/delta` (and its siblings) for such an item that arrives between `adoptConnection` and `hydrate` is lost, unless the `thread/turns/list` page that carries that turn already reflects it.

The path is the borrowed re-attach of OW-voyezi: `CodexAdapter.start` with a `resumeId` a live app-server still holds, through `adoptConnection` and `startBorrowed`; see the `session-manager.test.ts` block "re-attaching a thread a live app-server still holds (OW-voyezi)" and the `adapter.test.ts` block "re-attaching a thread whose turn is running (OW-vijuyi)" for the harness that drives it.
What the user would see: the running assistant message missing text in its middle, or missing entirely, until its `item/completed` replaces the slot.

How much is lost turns on something never measured: whether `thread/turns/list` at `itemsView: "full"` returns an in-progress turn's partial items, and with how much of their text, as of the current `codex-cli`.
If it returns none of them, the item is absent until `item/completed`; if it returns them with text as of the page's answer, only the deltas between that page and the last one are lost.

Done when an adapter test in `src/server/adapters/codex/adapter.test.ts` shows a delta for an item listed as in progress on an earlier `thread/turns/list` page, emitted before the last page, surviving into `getState()`, red against today's adapter first.
Or, if a live measurement on the home server (`codex -m gpt-5.6-luna`, per `AGENTS.md`) shows the window cannot lose anything, close this with that measurement recorded in `docs/MANUAL_TESTING.md` with the CLI version.

## Close note

Closed with OW-dutute on 2026-09-25, whose Codex half is this card's done-condition: `CodexReducer.applyDelta` now opens a slot for an item whose `item/started` preceded the attach, and the adapter test "keeps the deltas of an item that started before the attach (OW-zudase)" in the "re-attaching a thread whose turn is running (OW-vijuyi)" block went red against the old reducer and green after.
The measurement this card asked for, as of `codex-cli 0.156.0`: the mid-stream listing leaves a streaming `agentMessage` out of the `inProgress` turn it lists, so its deltas are its only text until `item/completed`.
What the fix does not reach (the running turn's state, and a listed partial item's head) is OW-dirazu.
