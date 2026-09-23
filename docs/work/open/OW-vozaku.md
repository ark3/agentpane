---
labels: [change, emacs]
blocked-by: [OW-kokalo]
---

# agentpane-mode reads an effort after the model and offers agentpane-set-effort, before the first prompt

OW-kokalo puts reasoning effort on the Emacs helper's JSON-RPC wire (`src/emacs/protocol.ts`) -- each model's effort options and default, and a way to set effort -- with no client UI.
This card is the Emacs half of that capability; the browser half is OW-kivahe, per `AGENTS.md`, "Both clients".

## Where the model's equivalent lives

In `emacs/agentpane.el`:

- `agentpane--read-model`, which reads a model from `models/list` with completion.
- `agentpane--check-model-gate`, whose docblock records that the browser and this mode enforce the gate and "neither the server nor the helper does".
- `agentpane-set-model`, and its handling of an empty choice (OW-kisemu).
- `agentpane-new-session`, which ends by reading a model and setting it.

The meta line already prints `:effort` when a turn carries it (the `effort` binding in the function that draws the footer's fields), so display needs nothing new.
Follow the model's shape: a reader, a gate, and an `agentpane-set-effort` command.

## Load-bearing

- The completion offers the session's current model's effort options, and `agentpane-new-session` reads an effort after the model only when that model has options.
- A backend or model with no effort options prompts for nothing -- the state Pi and Claude Code stay in until OW-ruzuhu and OW-hokaye land.
- `agentpane-set-effort` is refused once the buffer has nodes, as `agentpane-set-model` is.
- An empty choice sets nothing, for the reason `agentpane-set-model`'s docblock gives.

## Done when

- ERT tests in `emacs/agentpane-test.el` pin the effort read after the model in `agentpane-new-session`, the gate, the empty choice, and no prompt for a model without options, each shown red first; the test count in `agentpane.el`'s Commentary is updated.
- The whole ERT suite passes, run as the Commentary of `emacs/agentpane.el` gives it; `bun run check` is not that run.
