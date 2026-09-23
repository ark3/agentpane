---
labels: [change, emacs]
blocked-by: [OW-kokalo]
closed: done
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

## Close note

Landed on main as "feat: read an effort after the model in agentpane-mode, and offer agentpane-set-effort (OW-vozaku)", in `emacs/agentpane.el` and `emacs/agentpane-test.el`; nothing under `src/` changed.

The buffer keeps the model its last `session/snapshot` or `session/status` named in `agentpane--model`.
`agentpane--read-effort` reads `models/list` synchronously and offers that model's effort ids with completion, returning nil without a prompt when the model is nil, unlisted, or offers none.
The model's gate became `agentpane--check-gate`, naming what it guards; the model refusal reads as before.
`agentpane-set-effort` follows `agentpane-set-model`: gate, attach first, empty choice sends nothing, `sessions/setEffort` through `agentpane--attached-then`; interactively it user-errors when no model is known yet or the model offers no efforts.
`agentpane-new-session` reads an effort after the model for the model just chosen (or, on an empty model choice, the session's current one), since the status naming the new model may not have arrived; the order the server takes `setModel` and `setEffort` in does not matter, because the Codex adapter's `setModel` re-reads the effort after its await and replaces only one the new model does not list (read at 9850a05, not run live).

Verified: seven new ERT tests covering the effort read after the model, no prompt without options, the empty model choice, the gate called and interactive, the empty effort choice, and the offered list, each shown red by breaking the implementation; the dispatching session re-broke the gate and the empty-choice check and watched two go red.
The whole suite, run as the Commentary gives it, ends "Ran 83 tests, 83 results as expected, 0 unexpected" on Emacs 31.1.

Filed OW-zobiro for the effort missing from the mode line before the first turn, which the browser's select shows.
