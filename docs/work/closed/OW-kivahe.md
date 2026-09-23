---
labels: [change]
blocked-by: [OW-kokalo]
closed: done
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

## Close note

Landed in b0269e8 (`feat: offer an effort select beside the model select before the first prompt`).
An empty conversation's action row in `src/client/App.svelte` gains a select labelled "Conversation effort", listing the efforts of the `ModelInfo` whose id is the session's model, valued at the session's `effort` or else the model's `defaultEffort`, and following a model change.
It is absent when the model offers no efforts, when the list does not name the model, or when no model is known, and gone after the first turn with no label in its place, since each turn's footer already names its effort.
`controller.setEffort` mirrors `setModel`: its own `pendingEffortSets` and `effortSetting` flag, rename tracking, and an early return once the session has messages.
The e2e harness's models now offer efforts, so `e2e/model-select.spec.ts` checks the effort select fits the action row too.
Verified by App and controller tests, each shown red first (the dispatching session re-broke the `efforts.length > 0` gate and watched the three absence cases fail), `bun run check` (1202 tests) and `bun run test:browser` (22 tests) on main.
Label, placement and default option are a first cut.
Untested `setModel` gate noticed in review filed as OW-tebuze.
