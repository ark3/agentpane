---
labels: [defect, emacs-native]
---

# The subagent tool header is built in SubagentTool.svelte, not toolSummary, so the Emacs node summary for a Codex collab call drifts from the browser

Filed 2026-09-21 from the adversarial read of OW-mutufa.

`toolSummary` in `src/client/render/tools/summary.ts` is the one-line vocabulary the tool cards and reading view share, and OW-mutufa's projection in `src/emacs/nodes.ts` calls it for every tool part's `summary`.
`SubagentTool.svelte` does not use it: its header is the `tool` argument joined with the shortened `threadIds`, computed in the component (the `summary` derived beside `shortId`).
`toolSummary` has no `subagent` arm, so a Codex collab call falls through to `summarizeArgs` and the node's `summary` reads as a key list or a `tool: …, prompt: …` line, not the header the browser shows.

The fix is the pattern the card is built on: move the subagent header into `toolSummary` as an arm keyed on the same tool name `registry.ts` dispatches on, have `SubagentTool.svelte` read `toolSummary(call)` like the other cards, and add a structural assertion over the Codex `subagent` fixture (replayed through `CodexReducer` as `src/emacs/nodes.test.ts` does) that the node summary equals the header the component would draw.

Done when `summary.ts` has the arm, `SubagentTool.svelte` calls `toolSummary`, `src/client/render/tools/subagent.test.ts` and `src/emacs/nodes.test.ts` both pin the header, and `bun run check` passes.
