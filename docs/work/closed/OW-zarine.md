---
labels: [change]
blocked-by: [OW-meriva]
closed: done
---

# Pi now records each assistant message's thinkingLevel, which withLoadedEfforts says get_messages carries none of and reconstructs from level-change entries and a catalogue clamp instead

Filed 2026-10-14 from the home server's own Pi session files and the installed `pi 1.2.0` types.

`withLoadedEfforts` in `src/server/adapters/pi/reducer.ts` labels each loaded assistant message with the level it ran at, and its docblock opens on the premise: "`get_messages` carries none".
So it walks the active branch's `thinking_level_change` entries, matches messages to entries by `timestamp`, and clamps the result to the turn's model in today's `get_available_models` catalogue (OW-helumu, OW-lehita).
OW-niwube, closed `--declined`, names where that goes wrong — a turn recorded at a level its model has since dropped is labelled with the level that clamps to, plus two narrower cases its card lists — and was declined because "the fix has no clean source: the file records no catalogue".

The source may now exist.
On 2026-10-14 every assistant message in the four home-server Pi session files written since 2026-10-03 carried `thinkingLevel` (77 of 77, all `"high"`, with `providerThinkingLevel` `null`), and none of the 27 assistant messages in the nine files written 2026-09-14 to 2026-09-16 did.
`@earendil-works/pi-ai 1.2.0` declares `AssistantMessage.thinkingLevel?` and `providerThinkingLevel?`; the stamp is in `pi-agent-core`'s `agent-loop.js`.
Which Pi version started writing it is not known: no file on the home server dates from between those two groups, and Pi's changelog was not found to name it.

In service of D23 in `docs/DESIGN.md`, read per turn: a turn's label is the level it actually ran at.

## What is load-bearing

What `get_messages` returns on the installed `pi` is the fact this turns on, and it is measured, not inferred from the file: the field being on disk does not prove it is on the wire.
Older sessions keep working: a message without the field still gets today's reconstruction, so a session spanning the version boundary labels both halves.
Where the recorded field and the reconstruction would disagree, the recorded field wins, and the docblock says so.
What `providerThinkingLevel` means, against `thinkingLevel`, is read from the Pi source or docs before either is chosen; the samples above all had it `null`, which settles nothing.

## Done when

A live run on the installed `pi`, with the pinned `--model openrouter/deepseek/deepseek-v4.1-flash:high`, records in `docs/MANUAL_TESTING.md` whether `get_messages` carries `thinkingLevel` on assistant messages, with the version.
Whatever that run shows, the `withLoadedEfforts` docblock states it with the version, and every other copy of "`get_messages` carries none" is retired with it (grep the phrase; the `process.ts` docblocks naming `withLoadedEfforts` are candidates).
The `AssistantTurn` docblock in `src/shared/protocol.ts` ("the one fact about it that pi-ai has no field for", "nothing about effort") went false with OW-meriva's move to `pi-ai 1.2.0`, which declares `thinkingLevel?` and `providerThinkingLevel?` on `AssistantMessage`; OW-meriva left it alone because that file is FROZEN under D11, so this card states it with the version, raising it under D11 first if the change goes beyond the comment.
If it carries the field: a test loads a message whose `thinkingLevel` differs from what the entries and the clamp would give and asserts the recorded one, red before the change, and a test asserts a message without the field is labelled as today.
OW-niwube's close note is not edited; if this card fixes what it deferred, this card's close note says so and names it.

## Amended 2026-10-14 by OW-piyulu's execution: the preview reads the same field

The read-only preview has the same gap from the other side.
`storedAgentMessage` in `src/server/sessions/preview-message.ts` spreads a stored assistant message onto the preview wire, `thinkingLevel` included, but never sets the turn's `effort`, which is the only field the footer in `src/client/render/Message.svelte` reads, so a preview of a `pi 1.2.0` session names no level on any turn where the live transcript of the same run names `high`.
`src/server/sessions/pi-conformance.test.ts` lists that in `KNOWN_DIFFERENCES` under this card, on every assistant row of `tool-read-session` and `compact-session`, which were captured on `pi 1.2.0` and keep the session file Pi wrote (`resources/fixtures/pi/*.session.jsonl`).
The preview has the file itself, so it needs no `get_messages` measurement: it is done when `storedAgentMessage` names a recorded `thinkingLevel` as the turn's `effort`, a message without the field stays unlabelled as today, and every OW-zarine entry in that table is gone with the test passing, having failed first with the entries removed and the fix absent.
The same captures show the live stream carries it too: as of `pi 1.2.0` every assistant `message_end` in `resources/fixtures/pi/tool-read-session.jsonl` and `compact-session.jsonl` has `thinkingLevel: "high"`, so the level a live turn is named at could be read off its message rather than off `PiReducerState.effort`, whose docblock in `src/server/adapters/pi/reducer.ts` now says so and points here; whether to is this card's call, and the docblock is retired with the rest.

## Close note

Landed on main in four commits (892db0c, 3e76090, afa83b4, 761f5d3).

Measured: on the home server, 2026-10-14, `pi 1.2.0`, pinned `openrouter/deepseek/deepseek-v4.1-flash:high`, three turns at `high`, `low` and `off` — each assistant `message_end` carried `thinkingLevel` (`message_start` did not), and `get_messages` returned the same three values both live and after a `--session` resume while `high` was in force. No `providerThinkingLevel` on that model (`openai-completions` never sets it; in `pi-ai 1.2.0` only `anthropic-messages` and `pi-messages` do, and it is the provider's own effort string after `thinkingLevelMap`), so `thinkingLevel` names the turn. Recorded in `docs/MANUAL_TESTING.md`, "Pi stamps each reply with its level, and `get_messages` carries it (OW-zarine)".

Built:
- `withLoadedEfforts` (`src/server/adapters/pi/reducer.ts`) names a loaded turn by its stamp, unclamped, under the same "current model does not reason / `off` off the current model" rules; an unstamped message (written before the stamp, or a run failure's from `handleRunFailure`) keeps the entries-plus-clamp reconstruction.
- Live: the `message_end` arm renames a turn `message_start` named by the stamp; one it left unnamed takes the level in force at the end, as before.
- Preview: `storedAgentMessage` (`src/server/sessions/preview-message.ts`) names a stored `thinkingLevel` as `effort`, except `off`, which a file cannot tell from a model that does not reason; Codex call sites build literals with no such field.
- Every OW-zarine row is gone from `KNOWN_DIFFERENCES` in `pi-conformance.test.ts`; only OW-livowu's compaction marker remains.
- Retired "`get_messages` carries none" and its copies in `reducer.ts`, `process.ts`, `process.test.ts`, D23 in `docs/DESIGN.md`; the `AssistantTurn` docblock in `src/shared/protocol.ts` corrected, comment only (D11).

Verified: loaded, live and preview tests each shown red before the change (and the stamped-`off`-on-current-reasoning-model case red against a mutant); conformance test red with the rows removed and the fix absent; `bun run check` green on main (1654 tests). An adversarial reader's findings (docblocks overclaiming, "every reply" overbroad, unversioned comments, one untested branch) were fixed in 761f5d3.

This fixes what OW-niwube deferred for every stamped turn: a turn recorded at a level its model has since dropped is now named by its stamp, not by today's clamp. The mislabel remains only for turns written before `pi` began stamping (the home server's files from 2026-09-14 to 2026-09-16) and for run-failure replies.

Not established live: a non-reasoning model's `off` stamp, a resume `--model` suffix or `--thinking` override being stamped, virtual-model routing, `providerThinkingLevel` present — all rest on the source, as the MANUAL_TESTING section says.
