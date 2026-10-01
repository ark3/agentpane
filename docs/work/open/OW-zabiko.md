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

## Amended 2026-09-30 by OW-zadupu

The live names this card asked to measure first are measured, on the home server on `codex-cli 0.157.1` with `gpt-5.6-luna`: `resources/fixtures/codex/long-shell.jsonl`, `multi-patch.jsonl` and `collab-*.jsonl`, each with the rollout of the same run; `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
A `write_stdin` poll is folded into the same single `commandExecution` item live, so the preview's extra `exec` pair for it has no live counterpart.
A patch is a `fileChange` live, drawn as `edit`, and an `exec` script calling `tools.apply_patch` on disk, drawn as `exec`.
A script that calls no tool, such as the tool-list search Codex ran before a collab call, has no live item at all.
The `Script completed` / `Wall time` / `Output:` preamble is still in the stored output on 0.157.1.
`src/server/sessions/codex-conformance.test.ts` lists each of these in `KNOWN_DIFFERENCES` under this card, so a fold that lands shows up there as a failing entry to remove.

## Amended 2026-09-30 under OW-luvema

OW-luvema, filed 2026-09-30, has the preview build items from the rollout's `item_completed` records through live `mapItem` wherever a rollout carries them, which retires this card's preview-side differences for those rollouts (a `CommandExecution` record has no `Script completed` preamble, and a `FileChange` record is per path); its done-condition removes this card's `KNOWN_DIFFERENCES` entries.
A rollout with no item records keeps today's path, its differences accepted as a first cut, so read OW-luvema's outcome before working this card, and close it by what remains.
