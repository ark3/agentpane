---
labels: [defect]
---

# A Claude conversation reports no model until its first turn, and the picker calls that "Loading model…" when nothing is loading

`src/server/adapters/claude/adapter.ts` (`start()`, the `resumeId` branch; the `system`/`init` handling in the stdout path), `src/client/App.svelte` (`selectedModelLabel` and the `Conversation model` select's first option), `src/client/App.test.ts` (the assertion on "Loading model…").

## What happens

OW-derewo made the running model server state, reported on every snapshot and status event, and the composer renders it: a select while the conversation is empty, a label once it has a message.
Null means the adapter has not learned the model, and the composer renders null as "Loading model…" in both places.

For Claude that null is not transient.
The `init` system event is the only stream line that names the model, and it arrives with the first turn, not at spawn: `claude/adapter.ts`'s docblock records this as settled live on 2026-08-25, and `docs/MANUAL_TESTING.md` "Observed model selection through real backend turns (OW-derewo)" saw a fresh Claude conversation report null until Haiku was chosen.
So a fresh Claude conversation shows "Loading model…" in the select until the user picks or sends, and an older Claude conversation attached for reading shows "Loading model…" as its label until its next turn.
Nothing is loading in either case.
The wording came from OW-derewo, which described null as a transient state during `start()`; that was wrong for Claude and the implementer rendered what the card said.

Pi reports its model from `get_state` during `start()` and Codex from `thread/start` or `thread/resume`, so neither is affected.

## Two changes

**Seed the model from the transcript on resume.**
The `resumeId` branch of `ClaudeAdapter.start()` reads the store and hydrates the reducer before spawning.
The store's assistant records carry `model`, the same field the reducer reads from live assistant events (`claude/reducer.ts`, the assistant branch that falls back to `this.model`), so after hydration the reducer's messages already hold a model per assistant turn.
Take the last assistant message's model as the adapter's initial `this.model`, and emit it the way `init` does.
A resumed conversation then reports the model that last answered it, which is what its label should say.
An explicit `opts.model` still wins, as it does today.
A transcript with no assistant message stays null.

**Render null as the backend's default, not as loading.**
For a fresh Claude conversation null is truthful: agentpane passes no model flag, so the CLI's own configured default will answer, and agentpane cannot name it before the first turn.
Say that.
"Backend default" is the wording OW-derewo's first landing used for the same state, and it is accurate here for the reason it was not there: it is what the server reports, not what the client assumes.
The first landing also made that option unselectable once a concrete model was chosen, because no adapter offers a reset; keep that.
After the first turn the `init` event replaces it with the resolved model, as the live run showed.

## Done when

- A node test in `src/server/adapters/claude/adapter.test.ts` fails before and passes after, asserting that an adapter started with a `resumeId` whose store entries end in an assistant record with a model reports that model from `getState()` before any stream event, and that `opts.model` overrides it.
- A jsdom test in `src/client/App.test.ts` fails before and passes after, asserting that a selected empty session with a null model renders the default wording in the select and that a session with messages and a null model renders it as the label; the existing assertion on "Loading model…" changes to match.
- `bun run check` passes.

Claude resumes now seed and emit the last hydrated assistant model unless an explicit model was requested, while assistant-free transcripts remain null. Null models render as “Backend default” in both the empty-session picker and the messaged-session label, and concrete models exclude that synthetic option. Regression coverage proved the server state, override, emission, null case, and both client render paths; the new tests failed against the old behavior. Verified with `bun run check` (48 files, 932 tests), and `bun run test:browser` passed 20 tests for the client implementation.
