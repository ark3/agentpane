---
labels: [change, emacs, d27]
blocked-by: [OW-66]
---

# agentpane-mode's picker can neither star nor hide a session, nor show the server's session-less notice (D13, D27)

`emacs/agentpane.el` (`agentpane-sessions-mode`, `agentpane--session-entry`, and where the helper's notifications are dispatched), `emacs/agentpane-test.el`.

The Emacs half of marks, under `docs/DESIGN.md` D13 and D27.
OW-66 builds the server's store, the route, `mark` on `SessionSummary`, the helper's JSON-RPC method for setting a mark, and the helper's notification carrying the server's session-less notice; this card draws them.
Its browser twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

## What has to exist

- Picker commands to star a row, hide it, and return it to normal, on keys in `agentpane-sessions-mode`'s map, refusing on a row whose `onDisk` is false, the rule D27 and OW-66 take for D13's ban on marking a virtual session.
- The picker filters, as D13 decides the client does: a hidden row is absent unless a toggle shows hidden rows, and a starred row is drawn distinctly.
- The session-less notice is shown to the user where it outlives the next listing, not only echoed into `*Messages*`.

Incidental, decide in flight and say in the close note: the keys, whether starred rows sort first, and how the notice is shown.

## Done when

Each watched red first, in `emacs/agentpane-test.el`:

1. Starring a row sends the helper's mark method with the session and `starred`; on a row whose `onDisk` is false it sends nothing.
2. A listing holding a hidden summary draws no row for it, and draws one once the toggle is on.
3. The helper's notice notification leaves something the user can see after a following `sessions/list` redraws the picker.

Run the suite as the commentary at the head of `emacs/agentpane-test.el` gives it: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
