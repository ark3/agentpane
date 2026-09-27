---
labels: [change]
closed: done
---

# The browser's Bash card shows only the command, so Claude Code's Bash description never appears, where agentpane-mode shows every argument

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`src/client/render/tools/BashTool.svelte` reads only `command` (or `cmd`, `script`) from the call's arguments, through `argString` in `src/client/render/tools/args.ts`.
Every other argument the model sent is drawn nowhere.
`agentpane--tool-body` in `emacs/agentpane.el` shows the whole `args` JSON for every tool, so the Emacs client shows what the browser drops.

The loss is confirmed for Claude Code's Bash `description`: `resources/fixtures/claude/tool-use.jsonl` holds `"description":"Show current date"` on a Bash call.
Read's `offset` and `limit` are not a gap: `toolSummary` in `src/client/render/tools/summary.ts` puts them in the card's header, and `src/client/render/tools/tools.test.ts` asserts it.
Whether any other tool's renderer drops an argument is worth a look while the change is open.
How the extra arguments are drawn is this card's to choose.
What is load-bearing is that no argument the model sent is invisible in the browser.

Done when a test in `src/client/render/tools/tools.test.ts` renders a Bash call carrying a `description` and finds it, red before the change and green after.

## Close note

Landed as "fix(client): draw every argument of a shell call, so Claude Code's Bash description shows in the browser (OW-hokika)".
`BashTool.svelte` now draws every argument other than `command`/`cmd`/`script` as a JSON `Output` after the command, through a new `otherArgs(args, ...shown)` helper in `src/client/render/tools/args.ts`; the header summary is unchanged.
Codex bash cards consequently also show the `cwd` the Codex mapping puts in the arguments, which the Emacs client already showed.
Verified by "show every argument a shell call carried, not just the command" in `src/client/render/tools/tools.test.ts`, which renders a Bash call with `description: "Show current date"` and finds it in the card body: red against the old `BashTool.svelte`, green after (rerun by the dispatching session), and `bun run check` passed in full.
The survey of the other renderers found Edit dropping Claude Code's `replace_all` (filed as OW-goreyu) and the Codex multi-file loss already carried by OW-4; Write and Subagent drop nothing, and Read drops nothing any fixture shows.
