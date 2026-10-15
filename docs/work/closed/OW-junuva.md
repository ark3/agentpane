---
labels: [unverified, browser-testing]
closed: done
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

## Close note

Done 2026-10-14: `e2e/system-marker.spec.ts` seeds (via the new `seedSystem()` hook in `e2e/harness.ts`) a leading system message and a later one that replaces two sections, removes one and drops twelve tools, so its marker runs to scrollWidth 821 against a 480px box at the 900x700 viewport.
It asserts each `summary.system-marker` is one line box (17.05px tall against a 17.05px line-height), that the later marker overflows its box with computed `text-overflow: ellipsis` while `.conversation` does not scroll sideways, and that clicking the later marker sets `open` on its `<details>` and shows `.system-body`.
Seen red twice in headless Chromium: without `white-space: nowrap` the later marker measured 34.09px against a 25.575 limit, and without `overflow: hidden` it stayed one line but `.conversation` scrolled (scrollWidth 837 against 512) — the adversarial read found that second gap, which the first cut missed.
`bun run test:browser` 27 passed, `bun run check` clean.
Not covered, judged negligible: the leading marker fits the pane, so its one-line check cannot fail; only the later marker's disclosure is clicked (both share one element and class in `src/client/render/Message.svelte`).
OW-55, the same geometry claim for the thinking summary's `.preview`, is untouched.
