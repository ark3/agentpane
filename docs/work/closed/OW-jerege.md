---
labels: [change, emacs]
blocked-by: [OW-kihisa]
closed: done
---

# agentpane-mode has no Edit last message, nor the Stop and edit that takes a streaming Pi turn's last message back into the composer (OW-relehi)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's composer offers "Edit last message", which takes the last user message back into the composer as OW-kihisa's edit does, and on a streaming Pi turn offers "Stop and edit", which aborts the turn at the click first.
It is `lastUserIndex`, `editLastMessage` and `stopsBeforeFork` in `src/client/App.svelte`; closed OW-relehi is where it was built.
In `emacs/agentpane.el` a user moves point to the message and presses `f`, and `agentpane-fork` aborts a streaming Pi turn only at that press (ERT `agentpane-test-fork-aborts-a-streaming-pi-turn`).

This is blocked by OW-kihisa because it reuses that card's edit gesture; it adds only the shortcut to the last message and the abort before it.
The browser's behaviour is pinned by `src/client/App.test.ts` "stops the running turn and takes the last message back into the composer (OW-relehi)", "edits the last message into exactly the state" and "withdraws Edit last message when the last message is not a fork point".

Emacs has no standing control to withdraw, so the third mirrors as a refusal at the press when the last message is not a fork point.

Done when ERT tests in `emacs/agentpane-test.el` mirroring those three go red before the change and green after.

## Close note

Built `agentpane-edit-last` on `C-c C-e` in both `agentpane-transcript-mode-map` (it falls through the prompt region's map) and `agentpane-composer-mode-map`; from the composer the edit opens in the transcript's prompt region and the transcript is shown at the press.
It goes through `agentpane-edit`'s own path, factored into `agentpane--edit`, so it leaves exactly the edit `e` on the last user message leaves: fork points matched at the press, attach-first on a preview, `agentpane--start-edit`.
It takes the last user message to have arrived — nodes `agentpane--record` holds undrawn are drawn first — or none: one no fork point names is refused in the echo area as `e` refuses it, never an older one edited instead (OW-roveze), and a transcript with no user message is a `user-error`.
The refusal comes after the `sessions/forkPoints` round trip rather than at the press, because the Emacs buffer caches no fork points; the browser's `forkIndices` has no counterpart here.
On a streaming Pi session it aborts the turn once the points match and the edit is open, unawaited, as the browser's Stop and edit does; not through a compaction, mirroring the browser's `streamingAction`, and never on Codex or Claude Code.
Verified by ERT in `emacs/agentpane-test.el`: `agentpane-test-edit-last-stops-a-streaming-pi-turn`, `-leaves-the-state-edit-does`, `-refused-when-the-last-is-not-a-fork-point`, `-bound-where-a-prompt-is-typed`, `-edits-a-recorded-node-not-yet-drawn`, `-stops-nothing-idle-or-compacting`, each shown red against the code before it and by deliberate breakages (Pi condition dropped, streaming condition replaced by `t`, abort before the match); full suite 177 ran, 0 unexpected, 3 skipped.
The adversarial read found the undrawn-node mis-target, the compaction abort, and the composer's `pop-to-buffer` running in the async reply; all three fixed in the second commit.
Left as is: the stop is not announced in the echo area (as `f`'s Pi abort is not), and the turn-done indicator can raise for the stopped turn, which `agentpane--watch-turn` does for every abort by design, as `C-c C-a` and the browser's Stop do.
