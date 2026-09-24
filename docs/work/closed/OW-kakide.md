---
labels: [defect]
closed: done
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

A lead for the adapter-side fix, probed on the home server 2026-09-23 with no turn: as of `claude 2.1.280`, `get_settings` -- which `ClaudeAdapter` already sends at start to read the effort -- answers `applied.model` with the model in force, but as a resolved id (`claude-haiku-4-5-20251001`), not a listed one (`haiku`).
`initialize`'s model entries each carry `resolvedModel` beside `value` (`ClaudeModelDescriptor` in `src/server/adapters/claude/protocol.ts`), so a resolved id maps back to a listed one; several listed ids can share one resolved id (`default` and `opus[1m]` both resolved to `claude-opus-5-5[1m]` that day), so say which the mapping picks.
The same mapping serves the fork case above.

## Done when

- A test creates a Claude Code session with no model and asserts the effort control, or the status the clients key it on, offers the default model's efforts, shown red first.

## Close note

Fixed on the wire, so both clients get it with no client change: `ClaudeAdapter` in `src/server/adapters/claude/adapter.ts` now reads `get_settings`'s `applied.model` at start (`readSettings`, formerly `readEffort`) and, while the session has no model, maps that resolved id back to a listed one through `initialize`'s `resolvedModel` (`listedModelFor`), then emits the update.
Where several listed ids share one resolved id, `default` wins if it is among them, else the first listed; a model chosen at start or by `setModel` is never overwritten, and an unlisted resolved id leaves the model null.
The Emacs client's `agentpane--model` is fed from the same status (`statusOf` in `src/emacs/helper.ts`), so its "No model is known yet" refusal no longer fires for this case.

Verified by five tests in `src/server/adapters/claude/adapter.test.ts`, "naming the model in force when none was chosen"; the three that name a model failed against the unfixed adapter with `expected null to be 'default'` / `'sonnet'`, and the tie-break and keep-chosen tests were shown red by breaking the fix. `bun run check` green on main.

No-turn probes on the home server (`claude 2.1.280`, `docs/MANUAL_TESTING.md`, "What model a Claude Code session is on before its first turn, and what `--model default` runs (OW-kakide)") showed `--model default` and `set_model` to `default` put the same model in force as no `--model`, and that `default` names the account's recommended model rather than a settings `model` — which is why the adapter names `default` only when it resolves to the model actually in force, making it safe for `fork()` to pass on.
Not addressed, as the card scoped it: after the first turn the `init` event still replaces the name with a resolved id such as `claude-opus-5-5[1m]`, which no listed entry carries.
