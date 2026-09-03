---
labels: [change, browser-testing]
---

# A fresh conversation can choose its model from the composer before its first prompt, and the choice locks once the transcript has a message

`src/client/api.ts` (`AgentpaneApi`), `src/client/App.svelte` (the `.prompt-actions` row), `src/client/controller.ts`, `src/server/http/app.ts` (`listModels`), `src/shared/protocol.ts` (`ROUTES.models`, `ROUTES.model`, `ModelInfo`, `SetModelRequest`).

## Why now

OW-21 recorded on 2026-08-19 that the backend was the model choice and a picker might never earn its keep.
The owner said on 2026-09-03 that model selection at work has changed a great deal and the picker is now wanted.
The same conversation settled the shape: choose once, before the first prompt, and not mid-conversation.
Claude Code and Codex both discourage a mid-conversation switch on cost grounds, since the next turn pays fresh input tokens for everything the cache held.
Pi does not object, but the first cut locks all three the same way; relaxing Pi is a later card if it is missed.

## What is already built

Everything server-side.
`BackendAdapter.setModel` and `listModels` exist on all three adapters (`src/server/adapters/types.ts`; Pi in `pi/process.ts`, Claude in `claude/adapter.ts`, Codex in `codex/adapter.ts`).
`GET /api/models?backend=` and `POST /api/sessions/:backend/:id/model` are served by `src/server/http/app.ts` and typed in `src/shared/protocol.ts`.
Nothing under `src/client/` calls either route; OW-72 and OW-74 both name that gap and explicitly declined to fill it.

## Why the empty-list deferral does not bite here

OW-21 accepted that `GET /api/models` returns nothing when no adapter of that backend is live, because every adapter enumerates only from its running subprocess and D9 forbids spawning to answer a listing.
This picker never meets that case.
`controller.create` creates the virtual session and attaches it in one motion (`src/client/controller.ts`, `create` calling `attachAndSelect`), and attaching spawns the agent under the backend's default model.
So by the time the composer shows for a new conversation there is a live adapter of the selected backend, and the route's "prefer a live adapter" branch answers authoritatively.
Set-model before the first prompt costs nothing: no tokens have been sent.
The cache OW-21 sketches is therefore not needed for this card; whatever you find, record in OW-21 what this card's outcome means for it.

## What to build

A `<select>` in the `.prompt-actions` row of `src/client/App.svelte`, beside the existing controls, labelled for the accessibility tree the way the Theme and Backend selects are.
It carries a first entry meaning "backend default" that sends nothing, followed by the live list for the selected session's backend fetched through a new `listModels(backend)` on `AgentpaneApi`.
Changing it calls a new `setModel(ref, model)` on `AgentpaneApi` that posts `SetModelRequest` to `ROUTES.model(ref)`.
It is enabled only while the selected session's `messages` is empty (`src/client/session-state.ts`); once any message exists it renders disabled, still showing the chosen value, so it doubles as the "this conversation is on X" label.
Fetch the list when the selection changes, not on every render, and not for a session that already has messages.
A failed listing or a rejected set-model surfaces through the controller's existing `error` path, the same one attach and prompt failures use.

Placement was decided with the owner on 2026-09-03: the action row, not a header above the transcript.
The grid in `src/client/app.css` has no header row, so one would take height from the transcript; the action row already exists.
The masthead and the New controls were considered and rejected because a per-conversation control does not belong beside app-global or next-session controls.

## The route's silent failures

OW-21, section "One thing to fix whenever a picker is built": `listModels` in `src/server/http/app.ts` swallows both a factory that will not construct and a backend that cannot enumerate with bare `catch` blocks, so an empty list and a failed ask look identical to the client.
Fix that in this card so the select can show an error rather than an empty list.
Keep the merged unfiltered listing working; `src/server/http/app.test.ts` "lists models per backend, and merged when unfiltered" and the `modelsNeedStart` case beside it are the existing coverage to extend.

## Id shapes

`ModelInfo.id` is opaque to the client.
Pi ids are `provider/modelId` (see `modelToInfo` and `splitModelRef` in `src/server/adapters/pi/protocol.ts`), Claude ids are aliases such as `haiku`, Codex ids are bare names.
The select only ever sends an id it received, so no client-side validation is needed.

## Fork

A fork inherits the model without new work: the Claude adapter remembers `this.model` for its respawn, Codex reapplies `this.model` on the next `turn/start`, and a Pi fork stays inside the same process.
Do not add anything for it.

## Done when

- A jsdom test in `src/client/` (beside `App.test.ts` or `controller.test.ts`, whichever holds the seam you use; `controller.test.ts` has a `FakeApi implements AgentpaneApi` to extend) fails before the change and passes after, asserting that selecting a model on a session with no messages calls `setModel` with that ref and id, and that the select is disabled once a message exists.
- `bun run check` passes.
- `bun run test:browser` passes, with a new spec in `e2e/` modelled on `e2e/composer-shortcut.spec.ts`, asserting the row's controls still share one line and the page has no horizontal overflow with the select present; `.prompt-actions` does not wrap, so the failure mode is crowding, not a second line.
- OW-21 carries a note saying what this card's outcome means for the cache it sketches.
