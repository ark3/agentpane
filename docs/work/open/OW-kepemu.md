---
labels: [change, emacs]
blocked-by: [OW-vezipo, OW-jidihu]
---

# agentpane-mode's picker draws a fork's row as a copy of its parent's, with nothing marking the lineage forkedFrom carries (D27)

`emacs/agentpane.el` (`agentpane--session-entry` and the `tabulated-list-format` of `agentpane-sessions-mode`), `emacs/agentpane-test.el`.

The Emacs half of fork lineage, under `docs/DESIGN.md` D27.
OW-vezipo puts `forkedFrom` on `SessionSummary`; this card draws it.
Its browser twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

The row carries a fork marker whose `help-echo` names the parent by its label under D27's rule, or by its id when the parent is not in the listing or its label is empty, as agentpane-mode's rule leaves it when no name, preview or loaded transcript gives one.
Where the marker sits, its own narrow column or a prefix to the Session column OW-jidihu creates, is a first cut.
Hiding forks automatically is not this card's: D27 leaves it deferred until use says which forks deserve it.

## Done when

Watched red first, in `emacs/agentpane-test.el`: a picker row whose summary carries `:forkedFrom` naming a listed parent shows the marker with that parent's label in its `help-echo`, and a row with a null `:forkedFrom` shows none.

Run the suite as the commentary at the head of `emacs/agentpane-test.el` gives it: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
