---
labels: [defect, browser-testing]
---

# The `running` marker jumps to the left of its row whenever the summary beside it is empty, because nothing right-aligns it -- it only looks anchored while a flexing sibling happens to fill the gap.

`src/client/render/Transcript.svelte` -- the `.reading-tail` row and its `.tail-summary` / `.tail-state` rules.
`src/client/render/tools/ToolCard.svelte` -- the `<summary>` row and its `.summary` / `.status` rules.

Both rows are the same flex line: a fixed-width name, a summary at `flex: 1 1 auto`, then a marker at `flex: none`.
The marker's position on the right is not asserted anywhere; it is a side effect of the summary consuming the free space beside it.
Both templates render the summary conditionally -- `{#if tailStatus.summary}` and `{#if summary}` -- so when it is empty there is no span to push with and the marker sits flush against the name.

The reading tail hits this constantly rather than rarely.
`readingTailStatus` (`src/client/render/transcript.ts`) builds a thinking summary as `oneLine(block.thinking, 80)`, and a thinking block is empty at the moment it begins streaming, so `running` appears on the left and jumps right as the first tokens land.
Pi's signature-only thinking blocks carry no text at all (`resources/fixtures/pi/tool-read.jsonl`, and the `hidden` docblock in `Thinking.svelte`), so those stay left for their whole life.
`ToolCard` carries the identical defect and is simply seen less, because a tool call's summary is almost always non-empty.

The owner's call, 2026-09-02: the marker is right-aligned in every case, in both rows.

## The fix, and why it is safe

`margin-left: auto` on `.tail-state` and on `.status`.
Where the summary is present it changes nothing -- the flexing summary has already taken the free space, so there is none left for the auto margin to claim -- and where it is absent it does the job the sibling was accidentally doing.
It also makes the alignment a property of the marker rather than of another element's `flex` value, which is what let this regress unnoticed in the first place.

## Done when

- A browser test renders each row with an empty summary and asserts the marker's right edge sits at the row's content edge, within a pixel or two, rather than beside the name.
  The tail case is reachable through the existing reading-view fixtures in `e2e/`; the `ToolCard` case needs a tool call whose summary is empty.
- The same test, or a sibling, covers the non-empty summary so the fix is shown not to move the case that already looked right.
- Watched red first by reverting the two declarations; jsdom cannot discriminate here at all, since it has no layout, so a passing unit test would prove nothing.
- `bun run check` and `bun run test:browser` both green.

Load-bearing: both files, and that the assertion is a real computed position rather than a class or style-attribute check.
Incidental: the pixel tolerance.
