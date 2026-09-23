---
labels: [defect]
---

# A Claude Code conversation left on the default model offers no effort control in either client before its first prompt

OW-hokaye made Claude Code list per-model efforts and accept `setEffort` before the first prompt, but both clients key the effort control on the session's `model`, and a new Claude Code session has none until one is chosen or the first turn's `init` names it.
So a conversation created without choosing a model -- the browser's "New" button creates one that way -- shows no effort control, and the only window in which the effort may be chosen, before the first prompt, passes with nothing offered, while `getState().effort` already reports the CLI's pick (`high` on the default model as of `claude 2.1.280`).
Found by the adversarial read of OW-hokaye on 2026-09-23, read at the source and not run in either client.

## Where

- Browser: `selectedModelInfo` in `src/client/App.svelte`, under the comment "Efforts are per model (OW-kokalo): a model the list does not name offers none, and none offered shows no select".
  It looks up `selectedSession.model` in `view.models`, and a null model finds nothing.
- Emacs: `agentpane-set-effort` in `emacs/agentpane.el` refuses with "No model is known yet for this session; try again once one is" while `agentpane--model` is nil.
- Server: `ClaudeAdapter`'s `model` in `src/server/adapters/claude/adapter.ts` is `opts.model` or null at start, and is set from the `init` event only once a turn runs.
  `listModels` lists `default` (displayed "Default (recommended)") among the entries carrying `supportedEffortLevels`, so the default model does offer efforts; the session just never says it is on it.
- A related case: a fork adopts the model id the `init` event reported, a resolved id such as `claude-sonnet-5`, which is not one of the listed ids (`sonnet`), so a fork's effort control would find no entry either -- moot today only because a fork already has history and the clients gate effort to before the first prompt.

## Load-bearing

A Claude Code conversation that has not yet had a prompt offers the effort its current model supports in both clients, whether or not a model was picked.
Whether the fix is the adapter naming the model it is on at start or the clients falling back to the default entry is the implementer's call; per `AGENTS.md`, "Both clients", a fix on the wire serves both, and a client-side one lands in both or neither.
Codex and Pi report a model at start, so Claude Code is the backend where this shows.

## Done when

- A test creates a Claude Code session with no model and asserts the effort control, or the status the clients key it on, offers the default model's efforts, shown red first.
