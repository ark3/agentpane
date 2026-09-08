---
labels: [change, browser-testing]
---

# A fresh conversation can choose its model from the composer before its first prompt, and the choice locks once the transcript has a message

`src/server/adapters/types.ts` (`AdapterState`), the three adapters' state reporting, `src/server/http/broadcaster.ts` (`broadcastSnapshot`), `src/shared/protocol.ts` (`ServerEvent` `snapshot` and `status`, `ROUTES.models`, `ROUTES.model`), `src/client/session-state.ts` (`SessionView`), `src/client/api.ts` (`AgentpaneApi`), `src/client/controller.ts`, `src/client/App.svelte` (the `.prompt-actions` row).

## Second attempt

This card landed once as 99e21dc..0f83315 and was reverted in 86ba61f on 2026-09-08.
Read the revert's message and the reverted diff before starting; the small parts are correct and are meant to be lifted rather than rewritten: the two `AgentpaneApi` methods, the `<select>` markup in the action row, `e2e/model-select.spec.ts`, the `listModels` route change that surfaces a filtered backend's failure while the merged listing stays tolerant, and the `listModels`/`setModel` stubs in `e2e/harness.ts` and `e2e/perf-harness.ts`.

What was wrong is one decision, and everything else followed from it.
The first landing kept the chosen model as client state, in two maps inside the controller keyed by session.
So the locked select read "Backend default" for any conversation not chosen in that tab: every conversation that predated the page load, every fresh one after a reload, every one in a second tab.
The owner attached to an older conversation and saw exactly that.
And about a hundred and forty controller lines plus fifteen race tests existed only to keep those maps consistent across renames, stale selections, and interleaved list and set requests.

**The model is server state.**
The client never remembers a choice; it reads the session's current model from the server and renders it.
`setModel` is a request whose effect arrives on the next server event, the same way every other mutation in this client works.
That removes the maps, the rename bookkeeping, the intent guards around list and set, and the rule that a pending model change blocked sending on every conversation.

## Why now

OW-21 recorded on 2026-08-19 that the backend was the model choice and a picker might never earn its keep.
The owner said on 2026-09-03 that model selection at work has changed a great deal and the picker is now wanted.
The same conversation settled the shape: choose once, before the first prompt, and not mid-conversation.
Claude Code and Codex both discourage a mid-conversation switch on cost grounds, since the next turn pays fresh input tokens for everything the cache held.
Pi does not object, but the first cut locks all three the same way; relaxing Pi is a later card if it is missed.

## What is already built

Everything server-side except reporting the current model.
`BackendAdapter.setModel` and `listModels` exist on all three adapters (`src/server/adapters/types.ts`; Pi in `pi/process.ts`, Claude in `claude/adapter.ts`, Codex in `codex/adapter.ts`).
`GET /api/models?backend=` and `POST /api/sessions/:backend/:id/model` are served by `src/server/http/app.ts` and typed in `src/shared/protocol.ts`.

## Report the current model

Every adapter already knows it and none of them says so.
The Claude reducer takes the model from the `init` system event (`claude/reducer.ts`, `case "init"`) and the adapter records a successful `setModel`.
The Codex adapter takes it from the `thread/start` response and feeds it to its reducer's identity, and `setModel` stores the value that the next `turn/start` will carry.
The Pi adapter round-trips `get_state` during `start()` (`pi/process.ts`, the call that adopts `sessionFile`), and that response's `data.model` is the current model; `set_model`'s response is the new `Model`.

Follow compaction exactly, because it is the same kind of fact: a per-session value the adapter owns, reported on every snapshot and on every status change.
`AdapterState` in `src/server/adapters/types.ts` gains a `model: string | null` beside `compaction`; each adapter's `getState()` returns it and its `onUpdate` fires when it changes, including on a successful `setModel`.
The `snapshot` and `status` events in `src/shared/protocol.ts` carry it, `broadcastSnapshot` in `src/server/http/broadcaster.ts` copies it from state the way it copies `compaction`, and `SessionView` in `src/client/session-state.ts` stores it the way the `status` case stores `compaction`.
Null means the adapter has not learned it yet, which is a transient state during `start()`, not a "default" the client should name.

Report the id the backend uses, in the shape `ModelInfo.id` uses for that backend, so the select can match the current value against its options: Pi as `provider/modelId` (see `modelToInfo` in `pi/protocol.ts`), Claude and Codex as the bare id they answer with.
Where a backend reports an alias on `init` and a resolved name on turns, such as Claude's `haiku`, report what `setModel` would accept.

OW-9 records that the Codex reducer's identity may still say the previous model after `setModel` until the next turn.
With the model reported from the adapter's own record of a successful `setModel`, rather than from the reducer, that card's gap does not reach the picker; say so in OW-9 when you are done.

## The picker

A `<select>` in the `.prompt-actions` row of `src/client/App.svelte`, labelled "Conversation model" for the accessibility tree, as in the reverted markup.
Its value is the selected session's reported model, nothing else.
Its options are that backend's live list, fetched through `AgentpaneApi.listModels(backend)` when a session with no messages becomes selected, and never for a session that already has messages.
While the current model is null, or is not among the options, the select shows one extra entry naming the reported id, so the value on screen is always what the adapter has.
Changing it calls `AgentpaneApi.setModel(ref, id)` and does nothing else; the new value arrives on the `status` event.
There is no "backend default" entry: the backend's default is whatever the adapter reported at start, and it is shown by name.

The select is enabled only while the selected session's `messages` is empty.
Once the transcript has a message the control renders as a plain label carrying the model's name, not as a disabled select.
The owner said on 2026-09-08 that a forever-locked selector is silly; it stays a select while it can be changed because mid-conversation switching is expected to come later, and reads as a label the rest of the time.
That label is also what an older conversation shows on attach, and it must be the model that conversation is actually running.

Placement was decided with the owner on 2026-09-03: the action row, not a header above the transcript.
The grid in `src/client/app.css` has no header row, so one would take height from the transcript; the action row already exists.

A failed listing or a rejected `setModel` surfaces through the controller's existing `error` path, the one attach and prompt failures use.
No controller busy state and no send block.
Disable the select itself while its own request is in flight, so a second choice cannot overtake the first; a prompt sent in that window is the ordinary case of the server handling two requests in arrival order, and the reported model tells the user which one won.

## The empty-list deferral

OW-21 accepted that `GET /api/models` returns nothing when no adapter of that backend is live.
This picker never meets that case: `controller.create` creates the virtual session and attaches it in one motion (`src/client/controller.ts`, `create` calling `attachAndSelect`), so a live adapter of that backend exists before the list is asked for.
OW-21 already carries the outcome note from the first landing; it still holds.

## Fork

A fork inherits the model without new work: the Claude adapter remembers `this.model` for its respawn, Codex reapplies `this.model` on the next `turn/start`, and a Pi fork stays inside the same process.
The forked session's reported model must say so; assert it in whichever adapter test already covers fork.

## Done when

- A node test per adapter fails before and passes after, asserting `getState().model` after `start()` from the fixture the adapter already starts from, and after a `setModel`.
- A jsdom test in `src/client/` fails before and passes after, asserting that a selected empty session renders the reported model as the select's value, that choosing an option calls `setModel` with that ref and id and changes nothing locally, that a `status` event carrying a new model changes the value, and that a session with a message renders the model as a label and no select.
- A jsdom test asserts that attaching a session whose snapshot reports a model and carries messages shows that model, which is the case the first landing got wrong.
- `bun run check` passes.
- `bun run test:browser` passes, with `e2e/model-select.spec.ts` lifted from the reverted change and adjusted to the new default handling, asserting the row's controls still share one line and the page has no horizontal overflow with the select present.
- OW-9 carries a note saying what this card's reporting path means for its gap.
- One real turn per backend available on the home server, driven through the running app: choose the pinned model from the picker (`haiku` for Claude, `gpt-5.6-luna` for Codex; AGENTS.md "Evidence" says why those), send one prompt, and confirm the turn footer names that model.
  Record the run in `docs/MANUAL_TESTING.md`, and retire that log's standing line that `set_model`'s effect on a later turn is "still unverified since OW-yilabe" (in the "Honest scope" paragraph and the Claude control-request table's `set_model` row), since this is the run that verifies it.
  The owner drove this path by hand on 2026-09-08 and it worked; this criterion exists so the evidence outlives that session.
