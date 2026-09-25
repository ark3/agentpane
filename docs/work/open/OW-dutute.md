---
labels: [change, d24]
---

# A hydrate lays the stored history under what the live stream has already built, in Pi as in Codex, and a Codex delta for an item that started before the attach is kept

Filed 2026-09-24 under D24 in `docs/DESIGN.md`, the third of its three commitments; read that decision first.
In service of a transcript that never loses what the backend streamed while agentpane was reading its history back.

## Where hydrate stands today

Codex: `CodexReducer.hydrate` in `src/server/adapters/codex/reducer.ts` no longer resets since OW-vijuyi and lays the paged-in turns under the slots the live stream built; `start()` and `startBorrowed()` in `src/server/adapters/codex/adapter.ts` call it after `thread/resume` and the `thread/turns/list` pages (`readTurns`).
What that did not reach is OW-zudase: an item whose `item/started` arrived before `adoptConnection` has no slot until hydrate runs, and `applyDelta` drops a delta whose `slotFor` answers undefined, so every delta for such an item between `adoptConnection` and `hydrate` is lost unless the page already reflects it.
OW-5 closed moot on the premise that hydrate only ever ran on a fresh reducer, which is no longer true; that hydrate overwrites `threadId` and `turnId` per turn on top of live state is part of what this card reads.
Pi: `hydrateMessages` in `src/server/adapters/pi/process.ts` replaces the transcript wholesale, `this.state = { ...this.state, messages: labelled }`, called from `start()` on a resume and from `fork()` after the re-sent model and level.
Claude Code: `start()` hydrates from the store before `attachProcess` spawns anything and never rehydrates a live session (OW-toyeru's close note), so no live event can arrive during it; Claude Code is outside this card for that reason.

## What this card does

Codex: an item that started before the attach gets a slot when its delta arrives, or from the running turn at attach, so that OW-zudase's delta survives into `getState()`.
Which of those, and what `thread/turns/list` at `itemsView: "full"` answers for an in-progress turn as of the installed `codex-cli`, is measured first on the home server, `codex -m gpt-5.6-luna` per `AGENTS.md`, and recorded in `docs/MANUAL_TESTING.md` with the version; OW-zudase's body names both outcomes and each closes this card's Codex half.
Pi: measure what a live `pi` emits between a `fork` response and the `get_messages` answer that follows it, and on a resume between `get_state` and `get_messages`, driving a mid-stream fork through the built server as OW-sededi's cell did, with its delta gate, on `pi --model openrouter/deepseek/deepseek-v4.1-flash:high` per `AGENTS.md`.
Whatever arrives, record it in `docs/MANUAL_TESTING.md` with the version, and make `hydrateMessages` lay the branch Pi answers under the reducer state rather than replace it, so that a `message_update` or `message_end` landing in that window neither corrupts the rewound branch nor lands on the wrong message.

Load-bearing:

- D20: `ForkPoint.index` and the Emacs node `index` address the flat transcript, Codex's `indexOfItem` assumes hydrate and live fill `slots` identically (OW-roveze), and Pi answers no fork points at all when its user-message count disagrees with `get_fork_messages`; a merge keeps every index a client already holds meaning what it meant.
- A Pi fork truncates: the new branch excludes the forked-at message (OW-yudoni) and the parent's streamed partial stays in the abandoned file (OW-sededi), so on Pi the merge shrinks the transcript and drops the parent's in-flight slots rather than unioning them.
- A hydrated Codex item keeps going through `remap`, so `AssistantTurn.effort` survives (OW-61), and a live compaction slot keeps its start-time `compactionTokensBefore` (OW-kelomi, pinned in `reducer.test.ts`).
- Nothing is applied twice: a delta a page already reflects is not re-appended.

Incidental: where the Codex slot for a pre-attach item is opened, and whether Pi's merge is by position or by content, since Pi's messages carry no id.

## Done when

- OW-zudase's test, in `src/server/adapters/codex/adapter.test.ts` beside the block "re-attaching a thread whose turn is running (OW-vijuyi)": a delta for an item listed as in progress on an earlier `thread/turns/list` page, emitted before the last page, survives into `getState()`, red against today's adapter first.
  If the live measurement shows the window cannot lose anything, the Codex half closes on that record instead, as OW-zudase allows; OW-zudase closes with this card either way.
- A test in `src/server/adapters/pi/process.test.ts`, in the `PiAdapter.fork` block, scripting the fake child to emit a `message_update` for the abandoned turn between the `fork` response and the `get_messages` response, asserting `getState()` after `fork()` holds the rewound branch with nothing from that turn in it.
  Red first if today's replace lets the event through; whether it does is the measurement above, and if the scripted order cannot go red the test still pins the merge and `docs/MANUAL_TESTING.md` says why it could not.
- The `docs/MANUAL_TESTING.md` sections above, each naming the CLI version.
- `bun run check` green.
