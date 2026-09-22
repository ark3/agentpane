---
labels: [deferral]
---

# A stored Codex exec script that is not exec_command, such as write_stdin or a patch, still previews as the raw script, and a stored shell result carries a Script completed preamble the live path lacks

Filed 2026-09-22 while landing OW-jakahe, which folded the two stored shell-run shapes to `bash`.
Two leftovers from the same measurement, `docs/MANUAL_TESTING.md` "A Codex shell run is `commandExecution` live and `exec` or `exec_command` on disk (OW-jakahe)".

## Other scripts under the `exec` tool

On the home server, `codex-cli` 0.150.1 through 0.155.1, the `custom_tool_call` named `exec` is a general JavaScript tool, and `tools.exec_command` is only one of the functions it calls.
`bun run src/emacs/dump-nodes.ts codex/01a063bf-a891-73d1-bbef-34ac6a06d270` (a 2026-09-02 session) shows the others: `tools.write_stdin({session_id:70888,chars:"",yield_time_ms:30000,...})`, which polls a shell session `exec_command` started, and `const patch = "*** Begin Patch\n*** Update File: ..."`, which applies a patch.
`extractStoreTurn` in `src/server/sessions/codex.ts` leaves those on the fallback OW-jakahe kept deliberately, name `exec` and `arguments: { value: <script> }`, so the browser's session view and the Emacs projection show the script's first line.
Whether to teach the preview those scripts too, what the live wire names them (`commandExecution` again for `write_stdin`, `fileChange` for the patch, or something else), and how many shapes are worth matching by regex before the approach is wrong, is the decision this card defers.
Measure the live names first; the throwaway driver the OW-jakahe section describes is the instrument.

## The stored result preamble

The `custom_tool_call_output` for an `exec` call carries two `input_text` blocks, the first reading `Script completed\nWall time 0.2 seconds\nOutput:\n` and the second the command's output, while the live `commandExecution` item carries only `aggregatedOutput`.
`outputContent` in `src/server/sessions/codex.ts` passes both through, so a stored shell result opens with the preamble and a live one does not.
Deferred because it is text, not a wrong name, and nobody has yet read a preview and been misled by it.

## Done when

A decision is recorded here or in `docs/DESIGN.md` for each of the two: fold, strip, or leave, with the live names measured and the version named.
