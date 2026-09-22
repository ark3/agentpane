---
labels: [defect]
closed: done
---

# A stored Codex session whose shell runs arrived as exec_command function calls previews every one of them as an argument-key list instead of the command

Filed 2026-09-21 from OW-dekate's first render, where the Codex dump showed 28 identical tool lines reading `exec_command cmd, workdir, yield_time_ms, max_output_tokens`.

## What was measured

The stored session `codex/01a0c449-2767-73e2-8b2b-dd67cf4d6c1a` on the work laptop, written by `codex-cli 0.155.1` on 2026-09-21, carries its shell runs as `function_call` items named `exec_command` with arguments `{cmd, workdir, yield_time_ms, max_output_tokens}`: 28 of them, and no `local_shell_call` or `commandExecution` item at all.
`src/server/sessions/codex.ts` maps a `function_call` to a `toolCall` under its raw name (the branch beginning `if (payload.type === "function_call" || payload.type === "custom_tool_call")`) and only `local_shell_call` becomes `bash`.
So the preview reaches the browser as a tool named `exec_command`, `toolSummary` in `src/client/render/tools/summary.ts` knows only `bash` and `shell` and falls through to `summarizeArgs`, and the line shows the argument keys.
The browser's session view and the Emacs projection in `src/emacs/nodes.ts` both show the same line, since both go through `toolSummary`; the projection is not at fault.

## What was measured on 2026-09-22, amending the above

Measured on the home server on `codex-cli 0.155.1` with `gpt-5.6-luna`, one live `codex app-server` turn asking for a shell command; the transcript is in `docs/MANUAL_TESTING.md`, "A Codex shell run is `commandExecution` live and `exec` or `exec_command` on disk (OW-jakahe)".
The live wire presented the run as `commandExecution` with `command` set to `/bin/bash -lc '...'` and `source: "unifiedExecStartup"`, which `CODEX_TOOL_NAMES` renames to `bash`; there was no `dynamicToolCall`.
So the live transcript already says `bash` while the preview says `exec_command`, and one session shows two names for its shell tool: the worse defect of the two, and the fix goes in the preview, `src/server/sessions/codex.ts`.

The rollout that same turn wrote does not carry the laptop's shape either.
It stores the run as a `custom_tool_call` named `exec` whose `input` is a JavaScript string, `const r = await tools.exec_command({cmd:"echo probe-ow-jakahe\npwd",workdir:"/var/tmp/...",yield_time_ms:10000,max_output_tokens:1000}); text(r.output);`, with the object's keys sometimes quoted and sometimes bare across sessions.
Every one of the home server's 2280 stored shell runs, back to `cli_version` 0.150.1 on 2026-08-31, has that shape; none has a `function_call` named `exec_command` or a `local_shell_call`.
`parseArguments` cannot parse that string as JSON, so today the preview shows it as a tool named `exec` with one argument, `value`, holding the whole script.
Both stored shapes are the same unified exec tool and both must preview as `bash` with `command` set, or the defect stands on one machine or the other.
For the `exec` shape, lift `cmd` (and `workdir` as `cwd`) out of the script by matching the key followed by one double-quoted string literal, whose escapes are JSON's; where nothing matches, leave the item as it previews today rather than inventing a command.

## What done looks like

Tests in `src/server/sessions/preview.test.ts`, beside the existing `function_call` case there, feed a `function_call` named `exec_command` with a `cmd` argument and a `custom_tool_call` named `exec` whose input is the script above, and assert each preview's tool call is named `bash` with `command` set to the command and `cwd` set to the workdir, and that the following output item's `toolName` is `bash` too; both go red on `main` first.
A `function_call` under any other name still previews under its raw name, so the `wait_agent` and `spawn_agent` calls in the same sessions are untouched.
The `docs/DESIGN.md` note that names `commandExecution` as the shell item states the version it was measured on and adds the `exec_command` observation with its version.
Rerun `bun run src/emacs/dump-nodes.ts codex/01a0c449-2767-73e2-8b2b-dd67cf4d6c1a` on the laptop and the summary lines carry the commands.

## Close note

Closed 2026-09-22 on the home server.

Measured first, since the card left open what the live path calls the run: one live `codex app-server` turn on `codex-cli 0.155.1` presented it as `commandExecution`, which `CODEX_TOOL_NAMES` already renames to `bash`, so the preview was the side to fix.
The same measurement found the home server's rollouts store the run not as the laptop's `function_call` named `exec_command` but as a `custom_tool_call` named `exec` whose input is a script calling `tools.exec_command({cmd, workdir, ...})`, 2280 of them and none of the other shape; the card was amended with that before dispatch.
Evidence: `docs/MANUAL_TESTING.md`, "A Codex shell run is `commandExecution` live and `exec` or `exec_command` on disk (OW-jakahe)"; `docs/DESIGN.md` gained a note beside the Codex item table naming the version.

Built, in `src/server/sessions/codex.ts`: both stored shapes preview as a `toolCall` named `bash` with `{command, cwd}` and record `bash` for the following output item; the `exec` script's `cmd` and `workdir` are lifted by matching the key, bare or quoted, followed by one JSON-escaped string literal; a script without `cmd` previews as before.
Tests in `src/server/sessions/preview.test.ts`: shape A, shape B with bare and with quoted keys, and a non-`exec_command` script left alone; the first three were red before the fix.
`bun run check` passed (51 files, 1141 tests).
Rerunning `bun run src/emacs/dump-nodes.ts` on a home-server session with three `exec_command` runs shows each as `bash` with its command; the `write_stdin` and patch scripts under the same `exec` tool still show the raw script, and the stored result's `Script completed` preamble remains, both filed as OW-zabiko.
Commits 2716a77, 79ac7b5, 7cc91bf.
