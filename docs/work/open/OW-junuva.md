---
labels: [unverified, browser-testing]
---

# The one-line system-message marker has never been seen ellipsized in a real browser

OW-wavini drew each Pi `role: "system"` message as a one-line marker, the `<summary>` with class `system-marker` inside the `system` arm of `src/client/render/Message.svelte`, over a collapsed `<details>`.
Keeping it to one line rests on that rule's `white-space: nowrap`, `overflow: hidden` and `text-overflow: ellipsis`, applied to a `<summary>`, whose default `display: list-item` and disclosure triangle are exactly the layout jsdom cannot see.
A later system message's marker grows with what it changes — `systemView` in `src/client/render/system.ts` names every changed section and every tool added or removed — so a `--tools` change removing eight tools is long enough to need the ellipsis at an ordinary width.
OW-55 is the same unverified claim for the thinking summary's `.preview` span, and one browser pass can settle both.

In service of the owner's decision recorded in `systemView`'s docblock: a marker that wraps to several lines is the wall of text the decision exists to remove, only smaller.

## Done when

An e2e case under `e2e/` renders a transcript holding a leading system message and a later one whose marker is wider than the pane, and asserts that each `summary.system-marker` occupies one line box (for instance its `getBoundingClientRect().height` against its computed `line-height`) and that clicking it opens the disclosure; the case is seen red first by removing `white-space: nowrap` from `.system-marker`.
`bun run test:browser` passes.
