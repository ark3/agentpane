---
labels: [deferral]
---

# A multi-file edit flattens its hunks under the first path.

Codex reducer

The raw per-file data is retained, so this is fixable without recapturing
fixtures.

Added 2026-09-26 by OW-goreyu, which made `EditTool.svelte` draw every argument it does not already draw, through `otherArgs` in `src/client/render/tools/args.ts`.
`changes` is in `NESTED_KEYS` there, so the browser deliberately leaves out the whole `changes` array that `src/server/adapters/codex/mapping.ts` passes through on a Codex `fileChange` (`{ path, edits, changes: [{ path, kind, diff }] }`, see `resources/fixtures/codex/tool-edit.jsonl`), because drawing it as JSON would repeat every diff.
That hides more than the other files' paths: even a single-file change loses `changes[].kind` (`add`, `delete`, `update`), which `agentpane--tool-body` in `emacs/agentpane.el` prints and the browser draws nowhere.
The fix for this card should surface each file's path and `kind` on the browser's Edit card.

## Amended 2026-09-30 by OW-zadupu

A two-file patch is captured, on the home server on `codex-cli 0.157.1` with `gpt-5.6-luna`: `resources/fixtures/codex/multi-patch.jsonl`, with its rollout; `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
Live, the `edit` tool call's `changes` keeps both files, while `path` is the first file and `edits` holds only that file's hunk; the added file's `diff` is its raw content (`notes\n`) with no hunk header.
On disk the patch is an `exec` script calling `tools.apply_patch`, whose output is `{}`, so the preview has no per-file data to draw (OW-zabiko).
The capture confirms the line above: the per-file data is on the live wire, so the browser fix needs no recapture, and `multi-patch.jsonl` is a real input for its test.
