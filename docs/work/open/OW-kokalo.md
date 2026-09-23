---
labels: [change]
---

# A conversation's reasoning effort can be chosen beside its model before the first prompt, Codex first

The conversation header's model picker has no effort companion, so a conversation runs at whatever effort the backend defaults to, and the footer merely reports it (OW-61).
The owner wants to choose effort the way they choose the model today: before the first prompt only, fixed after it.
Every backend can switch effort mid-conversation, but that is out of scope; a later card lifts the gate if use asks for it.

This card lands the shared contract, the client control, and Codex.
Pi and Claude Code follow in their own cards, built against the contract this one lands.

## Where the model picker already lives

- `src/client/App.svelte`: the `select` labelled "Conversation model", and `chooseModel`.
- `src/client/controller.ts`: `setModel`, whose gate returns early once the selected session has any messages; `pendingModelSets`; `loadModelsForSelected`.
- `src/server/http/app.ts`: `sessionAction`'s `case "model"`, and `listModels`.
- `src/shared/protocol.ts`: `SetModelRequest`, `ModelInfo`, `ModelsResponse`, and the `status` event, which carries `model`.
- `src/server/adapters/types.ts`: `setModel`, `listModels`, and the state's `model`.

Follow that picker's shape rather than inventing a second one: an effort select beside it, gated the same way, with its own pending state.
`emacs/agentpane.el`'s `agentpane-set-model` mirrors the same gate for the Emacs client, which is out of scope here.

## Codex

Per the generated types in `resources/codex-protocol/`, as of `codex-cli 0.156.0`:

- `model/list` gives each model `supportedReasoningEfforts` (`ReasoningEffortOption`: `reasoningEffort` and `description`) and `defaultReasoningEffort` (`v2/Model.ts`); `listModels` in `src/server/adapters/codex/adapter.ts` drops both today.
- `TurnStartParams.effort` overrides "the reasoning effort for this turn and subsequent turns", the same way the adapter already sends `model` on `turn/start` -- see the `setModel` docblock, "Takes effect on the next `turn/start`".
- `ThreadSettings.effort` arrives on `ThreadSettingsUpdatedNotification`.

These are types, not a live measurement; the live run below confirms them.

## Load-bearing

- Effort options are per model: the list the control offers follows the selected model, and choosing a model whose list lacks the current effort falls back to that model's default rather than sending an unsupported value.
- A backend or model with no effort options shows no effort control at all -- the state Pi and Claude Code stay in until their cards land.
- The footer's effort (`turn.effort` in `src/client/render/Message.svelte`) must name the effort the turn actually ran at.
  Today the Codex reducer's `identity.effort` is set only from the `thread/start` and `thread/resume` responses (`setIdentity` in `src/server/adapters/codex/reducer.ts`), so an effort overridden on `turn/start` would leave the footer naming the old one -- the effort twin of OW-9.
- What a resumed Codex thread runs at is unmeasured: OW-pubulu found a resumed Pi spawn drops its model, and whether an effort overridden on `turn/start` survives `thread/resume` has never been read.
  Whatever the answer, state it in the adapter's docblock beside the effort field.

## Incidental

The protocol's shape -- a route beside `/model`, a widened `SetModelRequest`, new `ModelInfo` fields -- and the select's label and default option.
It is a first cut, to be iterated from use.

## Done when

- A Codex adapter test asserts `turn/start` carries the chosen `effort`, shown red first.
- A test asserts the footer's effort names the chosen effort after the first turn, shown red first.
- A client test shows the effort select offering the selected model's list, following a model change, disabled after the first prompt, and absent for a backend with no options.
- One live Codex turn on the home server, driven through agentpane with the model pinned to `gpt-5.6-luna` per `AGENTS.md`, at a non-default effort, is recorded in `docs/MANUAL_TESTING.md` with the `codex-cli` version and where the effort was read back from.
- `bun run check` passes.
