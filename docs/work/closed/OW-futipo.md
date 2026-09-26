---
labels: [change, emacs]
closed: done
---

# agentpane-mode draws an ordered list's markers as bare numbers, where the browser and the markdown read 1.

Noticed in OW-gunuke's live run on the home server, 2026-09-22, Emacs 31.1: a reply that was a markdown numbered list came through with each marker a bare number and a space, no period (`docs/MANUAL_TESTING.md`, "The native Emacs mode drives a Codex session live (OW-gunuke)", paragraph "Smaller things").
That is shr's own `ol` rendering, not anything the mode does: `shr-tag-li` formats the counter without a period, and a bare `emacs --batch` rendering `<ol><li>two</li><li>three</li></ol>` through `shr-insert-document` produced markers `1` and `2` with no period.
In service of the transcript buffer reading like the browser's transcript, which shows `1.`; nobody has called the Emacs rendering wrong, so this is a change and a small one.

The markdown is rendered in `emacs/agentpane.el` by the function that binds `shr-external-rendering-functions` around `shr-insert-document` (the entries `span`, `pre`, `code`, the headings and `table`); an `ol`/`li` entry there is the natural seat, and `agentpane--shr-h1` and its siblings are the prior art for one.
Keep visual-wrap's hanging indent for wrapped list rows, which that function's docstring promises.

Done when an ert test in `emacs/agentpane-test.el` renders a two-item ordered list and finds `1.` and `2.` as the markers, red before the change, and a wrapped item still hangs under its text.

## Close note

Built: `agentpane--shr-li` in `emacs/agentpane.el`, registered as the `li` entry in `agentpane--insert-html`'s `shr-external-rendering-functions`, draws an ordered item's marker as `1.` — a copy of `shr-tag-li`'s numbered arm (Emacs 31.1) with the period, so nested blocks indent past the whole marker; unordered items still go to `shr-tag-li`, and `<ol start>` still counts from its start because `shr-tag-ol` seeds the counter.
The visual-wrap pass's `adaptive-fill-regexp` now takes an optional period after the number, without which a wrapped ordered row lost its hanging indent; `2024 was a year.` in the fixture still matches as before.
Verified on GNU Emacs 31.1: new ert test `agentpane-test-ordered-list-markers-read-like-the-browser` failed against the old `agentpane.el` (markers `1 first`/`2 second`/`7 seventh`), and with only the regexp reverted its wrap-prefix check failed (nil where `(space :align-to (3 . width))` was expected); `agentpane-test-text-part-hanging-indents` now expects `1. first`/`2. second` at width 3.
Batch suite: "Ran 118 tests, 115 results as expected, 0 unexpected, 3 skipped" (the tty-tagged three).
Emacs-only change, so `bun run check` was not run.
The dated OW-gunuke "Smaller things" paragraph in `docs/MANUAL_TESTING.md` still records the bare-number markers as that run saw them; it was left as a record of that run.
Commit 4ce3d70 on main.
