---
labels: [change]
blocked-by: [OW-kokalo]
---

# Claude Code conversations get the effort picker, once a live run shows how claude 2.1.280 takes an effort level

OW-kokalo lands the effort contract, the client control and Codex; this card fills in Claude Code against that contract.

## Leads, unmeasured

From `@anthropic-ai/claude-agent-sdk` 0.3.246's `sdk.d.ts`, installed on the home server at `~/.bun/install/global/node_modules/@anthropic-ai/claude-agent-sdk/`, never checked against the CLI agentpane drives:

- `initialize`'s model entries carry `supportsEffort` and `supportedEffortLevels` (`low`, `medium`, `high`, `xhigh`, `max`); `ClaudeModelDescriptor` in `src/server/adapters/claude/protocol.ts` declares neither.
- An `apply_flag_settings` control request takes `{ effortLevel }`, with `max` session-scoped only.
- A `get_settings` control request reports `applied.effort`, which the types describe as the value "after env overrides, session state, org caps and model-support downgrades".
- At spawn, `--effort <level>` (`claude --help` on `claude 2.1.280`: low, medium, high, xhigh, max).

## Measure first

On the home server, with `claude --model haiku` per `AGENTS.md`:

- Does `claude 2.1.280` answer `initialize` with `supportsEffort` and `supportedEffortLevels` for Haiku?
- Does `apply_flag_settings` with `effortLevel` on a running stream-json process change what `get_settings` reports as `applied.effort`, and does the next turn run at it?

The `initialize` response carries the operator's account email; keep it out of every record (OW-yilabe).
If Haiku offers no effort levels, that is itself the finding, and it proves the absent-control path; running a costlier model to see the present path is the owner's call, asked for, not assumed.
Record the run in `docs/MANUAL_TESTING.md` with the CLI version.

## Where it goes

`src/server/adapters/claude/adapter.ts` (`setModel` over the `set_model` control request, `listModels` over `initialize`) and the spawn args in `src/server/adapters/claude/process.ts`.

## Load-bearing

- The process is already running when the picker is shown -- `listModels` needs it -- so a control request is the natural path.
  If the measurement shows none works, `--effort` at spawn is the fallback, and the card then says how the running process is replaced before the first prompt.
- The footer shows the chosen effort on Claude Code's assistant turns, as it does for Codex.
- What a `--resume` spawn runs at is stated in the adapter's docblock, whatever the answer; OW-pubulu is the model's twin of that question.

## Done when

- The measurement above is recorded in `docs/MANUAL_TESTING.md`.
- A test in `src/server/adapters/claude/adapter.test.ts` asserts the chosen effort reaches the CLI by whichever path the measurement chose, shown red first.
- The offered levels come from the `initialize` model entries, pinned by a test.
- `bun run check` passes.
