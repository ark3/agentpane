---
labels: [defect]
---

# A Pi turn loaded by get_messages carries no effort, so a fork or a resume blanks the footer effort on every earlier turn

OW-ruzuhu stamps Pi's thinking level onto assistant turns as `AssistantTurn.effort` (`src/shared/protocol.ts`), which the browser footer and the Emacs meta line show.
It stamps only in `reducePiNotification`'s `message_start` and `message_end` cases in `src/server/adapters/pi/reducer.ts`, from the level `process.ts` last saw on `get_state` or `thinking_level_changed`.
Turns that arrive through `get_messages` are never stamped: `hydrateMessages()` in `src/server/adapters/pi/process.ts` replaces the whole transcript with Pi's messages, which carry no level.

So the footer's effort depends on how a turn reached the adapter, not on the turn:

- A resumed session shows no effort on any turn before the first one streamed since the resume.
- A fork re-hydrates too, so it blanks the effort on turns this adapter itself watched stream, a moment before.
  OW-ruzuhu's adversarial read reproduced that over a fake child: a turn read `high` before the fork and `undefined` after.

Codex does not have this gap in the same shape: its `reducer.remap` spreads the thread's identity, effort included, into hydrated turns (`src/server/adapters/codex/`).
That is the current effort, not the one each turn ran at, so copying Codex would put a wrong label on turns from before an effort change.

The per-turn truth exists on disk.
As of `pi 0.87.1` the session file carries a `thinking_level_change` entry at every change, ahead of the turns it governs (`docs/MANUAL_TESTING.md`, "A Pi turn at a chosen thinking level, what `set_model` does to it, and what a resume keeps (OW-ruzuhu)", which lists a session file's entries in order), and `get_entries` is already spoken by the adapter.
Load-bearing: a turn's label is the level in force when it ran, read from those entries, not the level in force when it was loaded -- D23 in `docs/DESIGN.md`, read per turn.
Incidental: whether the walk reads `get_entries` or the session file, and whether one pass serves both the resume and fork paths.

## Done when

- A test in `src/server/adapters/pi/process.test.ts` hydrates a transcript whose entries change level between two assistant turns and asserts each turn carries its own level, shown red first.
- A test forks a session whose earlier turns streamed live and asserts they keep their level after the fork, shown red first.
- The two texts OW-ruzuhu wrote to describe the gap -- the effort docblock on `PiAdapter` in `process.ts` and the `effort` bullet in `src/emacs/protocol.ts` -- say that loaded turns carry a level too.
