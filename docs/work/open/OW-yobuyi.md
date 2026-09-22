---
labels: [defect]
---

# An interrupted Codex turn is marked aborted neither live nor in the stored preview, and live it inherits the previous turn's token count

Found by OW-gunuke's live run on the home server, 2026-09-22, `codex-cli 0.156.0`; the evidence is `docs/MANUAL_TESTING.md`, "The native Emacs mode drives a Codex session live (OW-gunuke)", paragraphs "The aborted turn carries no aborted mark" and "Codex does not keep the partial reply".
In service of the reader of a transcript being able to tell a reply that was cut off from one that finished; both clients already draw that mark for a message whose `stopReason` is `"aborted"` (`src/client/render/transcript.ts`, "A failed or aborted turn is the exception"; the warning face in `emacs/agentpane.el`), so the defect is that the Codex backend never supplies it.

## Live

An aborted turn's partial reply stayed in the buffer with a meta line reading `#3 · gpt-5.6-luna · effort medium · 15694 tokens`: no aborted mark, and the token figure exactly the previous turn's.
`src/server/adapters/codex/mapping.ts` builds assistant messages with `stopReason` `"pending"`, `"stop"` or `"toolUse"` only, chosen by `ctx.completed`, and the `turn/completed` arm in `src/server/adapters/codex/adapter.ts` clears `interruptedTurnId` without marking anything.
The token figure goes through `applyTokenUsage` in `src/server/adapters/codex/reducer.ts`, which lands a `tokenUsage` update's `last` on the most recent assistant message; whether Codex sent a stale `last` after the interrupt or the reducer applied an old one was not measured, and the fix needs to know which.
What `turn/completed` carries for an interrupted turn (a `status` on `turn`, as `turn.error` is read at "effects.push({ type: \"error\"" in the reducer) is the load-bearing wire fact; capture it before building on it, and name the version.

## Stored

The rollout keeps no assistant message for the interrupted turn: it holds a `turn_aborted` event with `reason: "interrupted"`, and a user-role message wrapping a `<turn_aborted>` notice.
`src/server/sessions/codex.ts` projects that notice as an ordinary `user` node — `bun run src/emacs/dump-nodes.ts codex/<thread id>` on the run's thread showed it at index 3 — because `SYNTHETIC_USER_PREFIXES` / `isSyntheticBlock` does not list it.
The partial reply is gone from disk, so the preview cannot show it; what it can do is stop presenting Codex's notice as something the user typed, and say the turn was interrupted.

## Done when

A test fed an interrupted turn's notifications, as captured, yields an assistant message with `stopReason: "aborted"` and no usage borrowed from an earlier turn, red before the fix.
A test fed a rollout carrying the `<turn_aborted>` user message yields no `user` node for it, red before the fix, and whatever it yields instead is shown in the preview.
