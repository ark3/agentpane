---
labels: [change]
---

# A conversation's reasoning effort can be set before the first prompt over both wires, Codex first

A conversation runs at whatever effort the backend defaults to, and the footer merely reports it (OW-61).
The owner wants to choose effort the way they choose the model today: before the first prompt only, fixed after it.
Every backend can switch effort mid-conversation, but that is out of scope; a later card lifts the gate if use asks for it.

This card lands the capability with no client UI: the shared contract, both wires, and Codex.
Per `AGENTS.md`, "Both clients", each client gets its own card blocked by this one, and Pi and Claude Code fill in their adapters in their own cards.

## Where the model's equivalent already lives

- `src/shared/protocol.ts`: `SetModelRequest`, `ModelInfo`, `ModelsResponse`, and the `status` event, which carries `model`.
- `src/server/http/app.ts`: `sessionAction`'s `case "model"`, and `listModels`.
- `src/server/adapters/types.ts`: `setModel`, `listModels`, and the state's `model`.
- `src/emacs/protocol.ts`: `models/list`, `sessions/setModel`, and `session/status`; their handlers in `src/emacs/helper.ts`, and the round trip pinned in `src/emacs/helper.test.ts`.

Follow the model's shape rather than inventing a second one.

## Codex

Per the generated types in `resources/codex-protocol/`, as of `codex-cli 0.156.0`:

- `model/list` gives each model `supportedReasoningEfforts` (`ReasoningEffortOption`: `reasoningEffort` and `description`) and `defaultReasoningEffort` (`v2/Model.ts`); `listModels` in `src/server/adapters/codex/adapter.ts` drops both today.
- `TurnStartParams.effort` overrides "the reasoning effort for this turn and subsequent turns", the same way the adapter already sends `model` on `turn/start` -- see the `setModel` docblock, "Takes effect on the next `turn/start`".
- `ThreadSettings.effort` arrives on `ThreadSettingsUpdatedNotification`.

These are types, not a live measurement; the live run below confirms them.

## Load-bearing

- Effort options are per model, so each model's list and default reach both wires, and a client can follow a model change without guessing.
- A model whose effort is set and then changed to one whose list lacks that effort falls back to the new model's default rather than sending an unsupported value.
- A backend or model with no effort options says so on the wire, so a client can show no control at all -- the state Pi and Claude Code stay in until their cards land.
- The turn's `effort` (`AssistantTurn` in `src/shared/protocol.ts`, which the browser's footer and the Emacs meta line both print) must name the effort the turn actually ran at.
  Today the Codex reducer's `identity.effort` is set only from the `thread/start` and `thread/resume` responses (`setIdentity` in `src/server/adapters/codex/reducer.ts`), so an effort overridden on `turn/start` would leave both clients naming the old one -- the effort twin of OW-9.
- What a resumed Codex thread runs at is unmeasured: OW-pubulu found a resumed Pi spawn drops its model, and whether an effort overridden on `turn/start` survives `thread/resume` has never been read.
  Whatever the answer, state it in the adapter's docblock beside the effort field.

## Incidental

The contract's shape -- a route beside `/model`, a widened `SetModelRequest`, new `ModelInfo` fields -- and the JSON-RPC method's name.
It is a first cut, to be iterated from use.

## Done when

- A Codex adapter test asserts `turn/start` carries the chosen `effort`, shown red first.
- A test asserts the turn's `effort` names the chosen effort after the first turn, shown red first.
- A server test sets effort over HTTP and reads the model list with its effort options back; `src/emacs/helper.test.ts` pins the same round trip over JSON-RPC.
- One live Codex turn on the home server, driven through agentpane with the model pinned to `gpt-5.6-luna` per `AGENTS.md`, at a non-default effort, is recorded in `docs/MANUAL_TESTING.md` with the `codex-cli` version and where the effort was read back from.
- `bun run check` passes.
