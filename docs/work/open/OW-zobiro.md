---
labels: [change, emacs]
---

# agentpane-mode's mode line names the session's effort beside its model, as status reports it

Before the first turn the browser shows the session's reasoning effort: its "Conversation effort" select in `src/client/App.svelte` is valued at the session's `effort`, or else the model's `defaultEffort` (OW-kivahe).
The Emacs client shows the model in the mode line but not the effort, so a user who ran `M-x agentpane-set-effort` (OW-vozaku) sees nothing confirm the choice until the first turn's meta line prints `:effort`.
Noticed in review of OW-vozaku on 2026-09-23; `AGENTS.md`, "Both clients", asks for parity.

## Where it lives

- `agentpane--set-status` in `emacs/agentpane.el` builds `agentpane--status-fields` from `session/snapshot` and `session/status` params, and already keeps `:model` there and in `agentpane--model`.
- Both notifications already carry `effort` (string or null), per the docblock of `src/emacs/protocol.ts`; no wire change is needed.
- Whether to fall back to the model's `defaultEffort` when `effort` is null, as the browser's select does, is a first cut for the implementer to make; that needs `models/list`, which `agentpane--set-status` does not call today, so showing the reported `effort` only, when non-nil, is the simple cut.

## Done when

- An ERT test in `emacs/agentpane-test.el` shows a status carrying `:effort` puts it in the mode line and one with a null effort does not, shown red first; the Commentary's test count in `emacs/agentpane.el` is updated.
- The whole ERT suite passes, run as the Commentary of `emacs/agentpane.el` gives it.
