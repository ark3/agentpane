---
labels: [change, emacs]
---

# agentpane-mode draws an ordered list's markers as bare numbers, where the browser and the markdown read 1.

Noticed in OW-gunuke's live run on the home server, 2026-09-22, Emacs 31.1: a reply that was a markdown numbered list came through with each marker a bare number and a space, no period (`docs/MANUAL_TESTING.md`, "The native Emacs mode drives a Codex session live (OW-gunuke)", paragraph "Smaller things").
That is shr's own `ol` rendering, not anything the mode does: `shr-tag-li` formats the counter without a period, and a bare `emacs --batch` rendering `<ol><li>two</li><li>three</li></ol>` through `shr-insert-document` produced markers `1` and `2` with no period.
In service of the transcript buffer reading like the browser's transcript, which shows `1.`; nobody has called the Emacs rendering wrong, so this is a change and a small one.

The markdown is rendered in `emacs/agentpane.el` by the function that binds `shr-external-rendering-functions` around `shr-insert-document` (the entries `span`, `pre`, `code`, the headings and `table`); an `ol`/`li` entry there is the natural seat, and `agentpane--shr-h1` and its siblings are the prior art for one.
Keep visual-wrap's hanging indent for wrapped list rows, which that function's docstring promises.

Done when an ert test in `emacs/agentpane-test.el` renders a two-item ordered list and finds `1.` and `2.` as the markers, red before the change, and a wrapped item still hangs under its text.
