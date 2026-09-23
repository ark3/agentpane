---
labels: [change]
blocked-by: [OW-kokalo]
---

# Claude Code conversations get the effort picker, once a live run shows how claude 2.1.280 takes an effort level

OW-kokalo lands the effort contract on both wires, the HTTP API and the Emacs helper's JSON-RPC, with Codex behind it and no client UI; OW-kivahe and OW-vozaku are the browser and Emacs controls.
This card fills in Claude Code's adapter, so both clients offer Claude Code effort without either changing.

## Measured: which models offer effort

On the home server on 2026-09-23, `claude 2.1.280` spawned as agentpane spawns it, with `--model haiku`, answered an `initialize` control request, sent with no turn, like this:

- `default`, `opus[1m]`, `claude-fable-5-1[1m]` and `sonnet` each carried `supportsEffort: true` and `supportedEffortLevels` of `low`, `medium`, `high`, `xhigh`, `max`.
- `haiku`, resolving to `claude-haiku-4-5-20251001`, carried neither field.

`ClaudeModelDescriptor` in `src/server/adapters/claude/protocol.ts` declares neither field today.
So under the `AGENTS.md` pin, a Claude Code conversation offers no effort, and a live run on Haiku can show only the absent control.
The `initialize` response also carries the operator's account; keep it out of every record (OW-yilabe).
Put this measurement in `docs/MANUAL_TESTING.md` alongside the run below.

## Leads, unmeasured

From `@anthropic-ai/claude-agent-sdk` 0.3.246's `sdk.d.ts`, installed on the home server at `~/.bun/install/global/node_modules/@anthropic-ai/claude-agent-sdk/`, never checked against the CLI:

- An `apply_flag_settings` control request takes `{ effortLevel }`, with `max` session-scoped only.
- A `get_settings` control request reports `applied.effort`, which the types describe as the value "after env overrides, session state, org caps and model-support downgrades".
- The active effort is "exposed to hook commands and Bash as the CLAUDE_EFFORT env var", so a turn can report the effort it ran at by running `echo $CLAUDE_EFFORT`.
- At spawn, `--effort <level>` (`claude --help` on `claude 2.1.280`: low, medium, high, xhigh, max).

## The live run, on Sonnet by the owner's exception

The owner granted on 2026-09-23 an exception to the Haiku pin for this card alone: one turn on `--model sonnet` at `low` effort, to show the present path working.
It does not widen the pin for anything else.

Drive it through agentpane, with the effort set by whatever path the adapter uses before the first prompt, and show both that the CLI accepted the effort (`get_settings`'s `applied.effort`, or wherever the run finds it) and that the turn ran at `low`.
Keep the turn to one short prompt.
Record the run in `docs/MANUAL_TESTING.md` with the CLI version and where `low` was read back from.

## Where it goes

`src/server/adapters/claude/adapter.ts` (`setModel` over the `set_model` control request, `listModels` over `initialize`) and the spawn args in `src/server/adapters/claude/process.ts`.

## Load-bearing

- The process is already running when the picker is shown -- `listModels` needs it -- so a control request is the natural path.
  If the run shows no control request works, `--effort` at spawn is the fallback, and the card then says how the running process is replaced before the first prompt.
- The chosen effort is stamped on Claude Code's assistant turns, so the browser's footer and the Emacs meta line both show it, as they do for Codex's.
- What a `--resume` spawn runs at is stated in the adapter's docblock, whatever the answer; OW-pubulu is the model's twin of that question.

## Done when

- The `initialize` measurement and the Sonnet run are recorded in `docs/MANUAL_TESTING.md`.
- A test in `src/server/adapters/claude/adapter.test.ts` asserts the chosen effort reaches the CLI by whichever path the run chose, shown red first.
- The offered levels come from the `initialize` model entries, pinned by a test.
- `bun run check` passes.
