---
labels: [change]
blocked-by: [OW-kokalo]
---

# The browser's conversation header offers an effort select beside the model select, before the first prompt

OW-kokalo puts reasoning effort on the HTTP API -- each model's effort options and default, and a way to set effort -- with no client UI.
This card is the browser's half of that capability; the Emacs half is its sibling card, labelled `emacs`, per `AGENTS.md`, "Both clients".

## Where the model select lives

- `src/client/App.svelte`: the `select` labelled "Conversation model", and `chooseModel`.
- `src/client/controller.ts`: `setModel`, whose gate returns early once the selected session has any messages; `pendingModelSets`; `loadModelsForSelected`.
- `src/client/api.ts`: `listModels` and `setModel`.

Follow that select's shape rather than inventing a second one: an effort select beside it, gated the same way (the `selectedSession?.messages.length === 0` branch in `App.svelte`, and `setModel`'s early return), with its own pending state.
The server enforces no gate for the model and the browser does; the effort follows the same split.

## Load-bearing

- The select offers the selected model's effort options, and follows a model change.
- A backend or model with no effort options shows no effort select at all -- the state Pi and Claude Code stay in until OW-ruzuhu and OW-hokaye land.
- The select is gone once the conversation has a turn, as the model select gives way to a label then; no effort label replaces it, because each turn's footer in `src/client/render/Message.svelte` already names the effort it ran at.

Its label, placement and default option are a first cut, to be iterated from use.

## Done when

- A client test in `src/client/` shows the effort select offering the selected model's list, following a model change, gone after the first prompt, and absent for a backend with no options, each assertion shown red first.
- `bun run check` passes.
