---
labels: [defect]
---

# A stored Codex session whose shell runs arrived as exec_command function calls previews every one of them as an argument-key list instead of the command

Filed 2026-09-21 from OW-dekate's first render, where the Codex dump showed 28 identical tool lines reading `exec_command cmd, workdir, yield_time_ms, max_output_tokens`.

## What was measured

The stored session `codex/01a0c449-2767-73e2-8b2b-dd67cf4d6c1a` on the work laptop, written by `codex-cli 0.155.1` on 2026-09-21, carries its shell runs as `function_call` items named `exec_command` with arguments `{cmd, workdir, yield_time_ms, max_output_tokens}`: 28 of them, and no `local_shell_call` or `commandExecution` item at all.
`src/server/sessions/codex.ts` maps a `function_call` to a `toolCall` under its raw name (the branch beginning `if (payload.type === "function_call" || payload.type === "custom_tool_call")`) and only `local_shell_call` becomes `bash`.
So the preview reaches the browser as a tool named `exec_command`, `toolSummary` in `src/client/render/tools/summary.ts` knows only `bash` and `shell` and falls through to `summarizeArgs`, and the line shows the argument keys.
The browser's session view and the Emacs projection in `src/emacs/nodes.ts` both show the same line, since both go through `toolSummary`; the projection is not at fault.

## What is not known

Whether the live app-server path presents the same run as `commandExecution` (which `CODEX_TOOL_NAMES` in `src/server/adapters/codex/mapping.ts` renames to `bash`) or also as a raw `exec_command` `dynamicToolCall`.
If live already says `bash`, the preview and the live transcript of one session disagree on the tool's name and card, which is the worse defect of the two.
Measure it before choosing where the fix goes.

## What done looks like

A test in `src/server/sessions/codex.test.ts` (or the client summary test, depending on where the fix lands) feeds a `function_call` named `exec_command` with a `cmd` argument and asserts the preview's tool call is named `bash` with `command` set, or that `toolSummary` yields the command for it; it goes red on `main` first.
The `docs/DESIGN.md` note that names `commandExecution` as the shell item states the version it was measured on and adds the `exec_command` observation with its version.
Rerun `bun run src/emacs/dump-nodes.ts codex/01a0c449-2767-73e2-8b2b-dd67cf4d6c1a` on the laptop and the summary lines carry the commands.
