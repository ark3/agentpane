---
labels: [change]
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
