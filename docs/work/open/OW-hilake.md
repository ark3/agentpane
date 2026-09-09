---
labels: [deferral]
---

# The expanded-block dialog claims `aria-modal` without trapping focus, and the streaming and thinking dots label bare spans that screen readers drop

Three accessibility gaps found by reading on 2026-09-09, none reproduced with a screen reader.

- `src/client/render/Expanded.svelte`: the panel has `role="dialog" aria-modal="true"` and takes initial focus, but Tab walks out of it into the transcript behind the backdrop.
  `BlockActions.test.ts` checks initial focus and restore only.
  Either trap focus inside the panel or make the rest of the page `inert` while it is open.
- `src/client/App.svelte`, the `session-streaming` and `session-finished` spans, and `src/client/render/Message.svelte`, the thinking `cursor` span: `aria-label` on a generic `<span>` has no role to attach to, so most screen readers announce nothing.
  `role="img"` with the label, or visually hidden text, is what reaches assistive technology.
- `App.svelte`, the `role="menu"` container under the composer (OW-72's tools menu): the role promises arrow-key movement between items, and none is bound.
  D14 makes the pointer path sufficient, so this is the role over-promising rather than a missing keyboard path; a `<div>` with a group label promises less and delivers it.

## Done when

A test per item in the component's test file asserts the new structure: focus stays inside the dialog on Tab from its last control, the dots carry a role, and the menu's role matches its behaviour.
