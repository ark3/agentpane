---
labels: [deferral]
---

# Only the last transcript entry is marked streaming, so an earlier concurrent pending tool call can look complete while it is still running.

Codex reducer

## Amended 2026-10-01 by OW-geselo

Read at b758f98: real, but client code, not the Codex reducer, and the two clients disagree.

The browser narrows twice: `Transcript.svelte` passes `streaming={isStreaming && entry.index === view.lastIndex}`, then `Message.svelte` passes `streaming={streaming && i === turn.content.length - 1}` to each block.
`toolState` in `src/client/render/types.ts` answers a call with no result `props.streaming ? "running" : "ok"`, so a pending call that is not the last block of the last message draws `data-state="ok"` in `ToolCard.svelte`.
The Emacs projection narrows by message only: `nodeFor` in `src/emacs/nodes.ts` sets `isStreaming && index === view.lastIndex` and passes it to every `toolPart`, so all pending calls in the last message show as running there.

Which backends produce it: Claude (`resources/fixtures/claude/tool-use.jsonl` holds Bash and Read in one API message, merged by `recompose`, with Bash's result arriving after Read's block began, so Bash was a pending non-last block) and Pi (pi-agent-core 0.84.1's `ToolExecutionMode` defaults to `"parallel"`, all calls in one assistant message).
The entry-level narrowing the headline names needs a visible message after a pending call, which neither of those makes but Codex can: it maps each item to its own message, and `resources/fixtures/codex/long-shell.jsonl` (`codex-cli 0.157.1`) has a reasoning item start and complete while a `commandExecution` is pending, invisible there only because `mapItem` maps empty reasoning to nothing.
A visible item in that place would leave the pending call a non-last entry, drawn "ok" in both clients; the Codex reducer is where such a message comes from, not where the defect is.

## Done when

Jsdom tests in `src/client/render/` assert `data-state="running"` on every pending card in two shapes: one streaming assistant message holding two `toolCall` blocks with no results (block level), and a pending tool call in an entry followed by another message while the turn streams (entry level); both go red first.
Cases in `src/emacs/nodes.test.ts` pin the same two shapes: the block-level one already passes there, and the entry-level one goes red first.
`bun run check` passes.
