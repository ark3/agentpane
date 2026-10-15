---
labels: [change, emacs]
blocked-by: [OW-wisifo]
closed: done
---

# Stop in Emacs puts the text of every steered prompt Pi had not delivered back in the prompt region

Filed 2026-10-15 by OW-yewiku; the decision is D16 in `docs/DESIGN.md` ("A prompt submitted mid-turn steers that turn, and a backend that cannot steer rejects"), and OW-wisifo carries the server and wire half this card is blocked by.
OW-fahoti is the browser's counterpart, and the two clients follow the same rule (AGENTS.md, "Both clients").

On Pi, a prompt steered into a running turn may still be queued when the user presses Stop.
After OW-wisifo, the `sessions/abort` result in `src/emacs/protocol.ts` carries the text of every prompt Pi cleared before the abort, empty on Claude Code and Codex and on a Pi with nothing queued.
As landed, the result is `AbortResponse`, a `queued` array of strings, when anything was cleared, and `null` otherwise.
OW-wisifo also has `PiAdapter.submit` refuse a prompt while a stop is awaiting Pi's answer, which reaches Emacs as an ordinary failed `sessions/prompt`.
This card puts that text back where the user types, so nothing the user typed is lost and nothing runs after Stop.

## Where

- `agentpane-abort` in `emacs/agentpane.el` sends `sessions/abort` and hands its result to `#'ignore`; it reads the result instead.
- The text goes back into the transcript's prompt region, which starts at `agentpane--prompt-start` (as `agentpane-send` reads it).
  A separate composer buffer (`agentpane--composer-name`) that sends to this transcript is the other place a user types; decide which the text goes to when one is open, and say why in `agentpane-abort`'s docstring.
- The region may already hold text the user started typing while the turn ran.
  Join as OW-fahoti does, which is Pi's own interactive mode's rule (`restoreQueuedMessagesToEditor` in `pi 1.2.0`'s `dist/modes/interactive/interactive-mode.js`): the returned texts joined by a blank line, then the current text after them, blank parts dropped.
- Whatever OW-wisifo decided for the abort sent ahead of a Pi fork applies to the Emacs copy of that sequence too: the `sessions/abort` `agentpane--fork-points` sends for the parent, the subject of `agentpane-test-fork-aborts-a-streaming-pi-turn`.
  It decided to drop what that abort clears, as the browser does, and the comment there says the words are then lost; keep the two clients' choice the same as OW-fahoti's.
- "Stop and edit": `agentpane-edit-last` opens the edit in the prompt region through `agentpane--edit` and then calls `agentpane-abort` on a streaming Pi session.
  Joined into the region there, the returned text would be sent into the fork as part of the edit; decide where it goes instead, matching OW-fahoti's choice for the browser's "Stop and edit", and say so in `agentpane-edit-last`'s docstring.

## What OW-fahoti landed, 2026-10-15

The browser's choice, which this card matches: where the words go is decided by what the composer holds when the answer lands, never by which command sent the stop.
Every stop, the Stop button's and "Stop and edit"'s, holds the texts until no edit is open and no prompt is in flight, then joins them ahead of whatever the composer holds; with neither in the way that is at once.
So after Cancel they land ahead of the displaced draft, after a fork's prompt lands they fill what it leaves, and an edit ended by a session switch or by a fork whose prompt failed after the selection moved leaves its text as a plain draft they join ahead of.
The case that made the browser change shape: a plain Stop pressed while an edit is open (the transcript's edit control during a Pi turn, then Stop), or Stop and then "Stop and edit" before the first stop answers, joined the words into the edit's text, where the fork sent them or Cancel overwrote them.
`agentpane-abort` is the plain Stop here, so the same case applies to an edit opened through `agentpane--edit` by any path, not only `agentpane-edit-last`.
The browser's rule lives at `stop()` and the release `$effect` beside `heldQueued` in `src/client/App.svelte`, and the join at `withQueued` in `src/client/controller.ts`.

## Done when

- An ERT test in `emacs/agentpane-test.el`, red first, answers `sessions/abort` with two texts while the prompt region holds other text, and asserts the region afterwards holds the two texts and then the old text, joined by blank lines; and another asserts an empty answer leaves the region untouched.
- An ERT test, red first, drives `agentpane-edit-last` on a streaming Pi session whose `sessions/abort` answers with a text, and asserts the prompt region holds only the edited message and the text is where the decision above put it.
- An ERT test, red first, runs `agentpane-abort` while an edit is open in the prompt region and its answer carries a text, and asserts the region holds only the edited message and the text is where the decision above put it.
- If the text goes to an open composer buffer, an ERT test asserts that too.
- The ERT suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
- `bun run check` passes if anything under `src/` changed.

## Close note

Landed on main as d0016b9b, a4468c29 and 1ef4b874 (emacs/agentpane.el, emacs/agentpane-test.el; nothing under src/, so no `bun run check` was needed).
`agentpane-abort` now reads `sessions/abort`'s `:queued` into a buffer-local `agentpane--held-queued`, and one function, `agentpane--release-queued`, joins the texts ahead of the prompt region with `agentpane--with-queued` (the browser's `withQueued` rule) once that buffer has no edit open (`agentpane--editing`) and no prompt in flight (`agentpane--sending`).
It runs at the abort's answer, at `agentpane-cancel-edit`, at `agentpane--send-prompt`'s answer and failure, at `agentpane--send-edit`'s `free` and success, and in `agentpane--absorb`, which hands a merged-away buffer's held texts to the survivor's queue.
This matches OW-fahoti: what the region holds when the answer lands decides where the words go, not which command sent the stop.
Decisions, recorded in the docstrings: the texts always go to the transcript's prompt region, never a composer, because every transcript has one, an edit lives there, a transcript can have zero or several composers, and `agentpane-composer-discard` kills composer text unasked (`agentpane-abort`). They stay in the stopped buffer, not the fork's, because Emacs has a prompt region per buffer where the browser has one global composer (`agentpane-edit-last`). The fork path's own abort still drops its `:queued`, as the browser's does.
Verified by six new ERT tests, each shown red first against the unchanged code or with its release removed: two texts ahead of a draft, a blank draft and a nil answer; `agentpane-edit-last` with Cancel and with a send; a plain abort during an open edit; an abort behind a prompt in flight; an edit cancelled mid-send; and merges with and without an edit on the survivor, with the order of both buffers' texts asserted.
An adversarial reader also killed 11 of 12 mutations; the survivor became the merge-order test.
The full ERT suite on main: 268 run, 265 as expected, 0 unexpected, 3 skipped (the same three as before).
Review found and fixed a loss in the first cut: `agentpane--absorb` joined the held texts into the draft, which a survivor's open edit took as its `:draft` and a fork dropped.
Left open: a Stop answered before an edit's `sessions/forkPoints` returns lands in the region and is then displaced into the edit's draft, which a fork drops. That is amended into OW-kijuju. An abort still in flight when a merge kills its buffer loses its `:queued`; that is amended into OW-larele. `agentpane--gone` and a plain buffer kill don't put held texts on the kill ring, and no reachable path for the first was found.
