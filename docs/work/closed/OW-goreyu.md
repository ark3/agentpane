---
labels: [change]
closed: done
---

# The browser's Edit card drops Claude Code's replace_all, where agentpane-mode shows every argument

Found while executing OW-hokika on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`src/client/render/tools/EditTool.svelte` reads only the path keys (through `argString`) and the hunks (through `editHunks`, both in `src/client/render/tools/args.ts`).
Every other argument the model sent is drawn nowhere, while `agentpane--tool-body` in `emacs/agentpane.el` prints the whole `args` JSON.
The loss is confirmed for Claude Code's Edit `replace_all`: `resources/fixtures/claude/tool-use.jsonl` and `resources/fixtures/claude/permission-request.jsonl` both carry `"replace_all":false` on an Edit call.
`replace_all: true` changes what the diff means -- every occurrence, not one -- so it is the argument a reader most needs to see.

OW-hokika fixed the same gap on the Bash card with `otherArgs` in `args.ts`, drawn by `BashTool.svelte` as a JSON `Output` after the command; reuse it rather than adding a second mechanism.
What is load-bearing is that no argument is invisible, not the JSON form.
Passing Edit's arguments through `otherArgs` naively would also dump the hunk keys (`old_string`, `new_string`, `edits`) and, for a Codex `fileChange`, the `changes` array with its full diffs, which the card already draws as a diff; exclude what the card draws.
The multi-file `changes` case itself is OW-4, not this card.
`ReadTool.svelte` has the same shape (path, `offset`, `limit` only) but no fixture shows it dropping anything; include it only if the same exclusion list falls out naturally.

Done when a test in `src/client/render/tools/tools.test.ts` renders an Edit call carrying `replace_all: true` and finds it in the card's body, red before the change and green after, and the same test finds no `old_string` key in the body's text, so the hunks are not drawn twice.

## Close note

Landed in c6ca9b7. `EditTool.svelte` now draws, as a JSON `Output` after the diff, every argument it does not already draw. It uses OW-hokika's `otherArgs`, excluding two new exports from `src/client/render/tools/args.ts`: `PATH_KEYS`, and `EDIT_HUNK_KEYS`, which is built from the same key lists `editHunks` reads, so the two cannot drift apart.
Claude Code's Edit now shows `{"replace_all": ...}` in the browser, as agentpane-mode already did.
Verified by a new test in `src/client/render/tools/tools.test.ts`, "shows every argument it does not draw as the diff, and not the hunks twice": red on the old source, green after. It also asserts that neither `old_string` nor `file_path` appears in the body text. The Pi nested-edit test also asserts that `oldText` does not appear. Each exclusion was removed in turn and its assertion was seen to go red. `bun run check` is green, 1461 tests.
ReadTool was left alone: its summary line already shows `offset` and `limit`.
The adversarial read found that Codex's `changes[].kind` is still hidden, even on a single-file change. It is appended to OW-4, since it has the same fix site as the multi-file case.
Shapes the exclusions could still hide but no fixture produces: `edits` sent as a string, or a flat pair beside a nested `edits`. Neither was filed.
WriteTool reads only `path` and `content`. No fixture shows it dropping anything.
