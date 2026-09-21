---
labels: [defect, emacs-native]
closed: done
---

# The subagent tool header is built in SubagentTool.svelte, not toolSummary, so the Emacs node summary for a Codex collab call drifts from the browser

Filed 2026-09-21 from the adversarial read of OW-mutufa.

`toolSummary` in `src/client/render/tools/summary.ts` is the one-line vocabulary the tool cards and reading view share, and OW-mutufa's projection in `src/emacs/nodes.ts` calls it for every tool part's `summary`.
`SubagentTool.svelte` does not use it: its header is the `tool` argument joined with the shortened `threadIds`, computed in the component (the `summary` derived beside `shortId`).
`toolSummary` has no `subagent` arm, so a Codex collab call falls through to `summarizeArgs` and the node's `summary` reads as a key list or a `tool: …, prompt: …` line, not the header the browser shows.

The fix is the pattern the card is built on: move the subagent header into `toolSummary` as an arm keyed on the same tool name `registry.ts` dispatches on, have `SubagentTool.svelte` read `toolSummary(call)` like the other cards, and add a structural assertion over the Codex `subagent` fixture (replayed through `CodexReducer` as `src/emacs/nodes.test.ts` does) that the node summary equals the header the component would draw.

Done when `summary.ts` has the arm, `SubagentTool.svelte` calls `toolSummary`, `src/client/render/tools/subagent.test.ts` and `src/emacs/nodes.test.ts` both pin the header, and `bun run check` passes.

## Close note

Landed on main as e21ac06.
`toolSummary` in `src/client/render/tools/summary.ts` gained a `subagent` arm that builds the header the way `SubagentTool.svelte` did: the `tool` argument, then each `threadIds` entry cut to 8 characters, joined with " · ".
The thread-id filter moved into an exported `subagentThreadIds` helper that both the arm and the card body use, and `SubagentTool.svelte` now reads `toolSummary(call)` for its header like the other cards.
`src/client/render/tools/subagent.test.ts` pins the header on the rendered card for a `wait` with a child id and a `spawnAgent` with none.
`src/emacs/nodes.test.ts` replays the Codex `subagent` fixture through `CodexReducer` and asserts each `subagent` node summary starts with the operation and carries the short id of every thread the call names.
Both new tests were run red against the unchanged `summary.ts` (nodes: summary read `tool: wait`; card: header was the component's own) and green after the arm.
`bun run check` passed, 1137 tests.
The fixture holds no spawn with empty `threadIds` after replay, since the reducer fills the id in on completion, so the empty shape is pinned only by the hand-built call in the component test.
