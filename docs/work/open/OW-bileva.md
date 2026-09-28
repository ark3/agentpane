---
labels: [change, emacs]
blocked-by: [OW-kihisa]
---

# agentpane-mode's edit says C-RET forks even when the send will first stop a streaming Pi turn, where the browser's button says Stop and fork

Found by the adversarial read of OW-kihisa on 2026-09-27; the parity rule is `AGENTS.md`, "Both clients".

OW-kihisa's `agentpane-edit` (`e`) in `emacs/agentpane.el` marks an open edit with an overlay over the prompt separator whose text is fixed at the press: "editing … · C-RET forks there · C-c C-k cancels".
A send of that edit on a Pi session whose turn is streaming aborts the turn before forking, through `agentpane--fork-points`, exactly as `f` does.
The browser labels that same send "Stop and fork" (`sendLabel` and `stopsBeforeFork` in `src/client/App.svelte`), and `docs/DESIGN.md` D15 says that label "is the only warning the user gets" for a loss the abort makes deliberate.

Load-bearing: while an edit is open on a Pi session, the text naming what C-RET does says it stops the turn exactly when `agentpane--streaming` is true, and goes back when the turn settles or the edit is re-targeted.
The exact wording, and whether it lives in the overlay or elsewhere, is this card's to choose; D15 "The warning stays as it is" records that the owner wants the consequence named and nothing more.
OW-jerege, the Stop and edit shortcut, touches the same state and may land either side of this.

Done when an ERT test in `emacs/agentpane-test.el`, run as that file's Commentary says, goes red before the change and green after: it opens an edit on a Pi buffer, drives a turn start and a turn end through the notifications the existing streaming tests use, and asserts the edit's displayed text names the stop only while the turn streams.
