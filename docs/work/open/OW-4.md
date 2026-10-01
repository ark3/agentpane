---
labels: [deferral, emacs]
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

## Amended 2026-10-01 by OW-novuye

This card has an Emacs half, and per `AGENTS.md`, "Both clients", it lands in both clients.
`fileChangeArguments` in `src/server/adapters/codex/mapping.ts` builds `edits` from every file's hunks with no path between them, so both clients draw a multi-file update as one run of hunks under the first path, and the summary counts them under that path too.
On `multi-patch.jsonl` the second file is missing from the hunks altogether, because it is an `add` whose `diff` is raw content with no `@@` header, which `parsePatch` makes nothing of; both paths do reach the result text, as `--- <path>` lines.
So the per-file data has to come from `changes[]`, never from `edits`, and an `add`'s raw content becomes added lines as `diffFor` already does for `write`.
The mapping reduces `kind` to `kind.type`, dropping an update's `move_path`; no fixture holds a move or a `delete`, so what Codex sends for either is unmeasured, and this card draws the kind as the type alone.

OW-novuye decided that the elisp never parses `args`, which is display text, and recorded that in the `src/emacs/protocol.ts` docblock.
So the Emacs half adds `files` to `ToolPart` there: one entry per file an edit or write touches, carrying its path, its kind where the backend names one, and its diff lines, derived in `diffFor` in `src/emacs/nodes.ts`.
It retires the flat `diff` and `NodeDiffLine`'s place on the part in the same change, which reaches the `diff` paragraph of the docblock's Parts section and its orphan sentence ("with `args` empty and no `diff`"), the `diff` assertions in `src/emacs/nodes.test.ts`, the `:diff` on the Edit part of `agentpane-test--nodes` in `emacs/agentpane-test.el` and the face test that reads it, and `agentpane--tool-body` in `emacs/agentpane.el`, which draws `files` in its place.
It also replaces the docblock's sentence naming `files` as pending with one saying it landed.
The browser half is the paragraph above: each file's path and `kind` on the Edit card, its hunks under it.

## Done when

- A client test renders the Edit card for a two-file update and sees each file's hunks under its own path with its `kind`, red before the change and green after; `multi-patch.jsonl` alone cannot show the grouping, since its second file contributes no hunk, and both its paths already appear in the result text.
- A test in `src/emacs/` projects `multi-patch.jsonl` and sees two `files` entries, the second an `add` with `notes` as an added line, and no `diff` on the part.
- An ERT test in `emacs/agentpane-test.el` draws a tool node carrying two `files` and empty `args` and `result`, and sees both paths in the folded body.
