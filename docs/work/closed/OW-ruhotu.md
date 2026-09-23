---
labels: [defect, emacs-native]
closed: done
---

# agentpane-mode's transcript buffers take their default-directory from whichever buffer created them, not from their session's cwd

Owner, 2026-09-23: every agentpane buffer has as its `default-directory` the directory of the first one attached; each should have its own session's project directory.

## Why

`agentpane--transcript-buffer` in `emacs/agentpane.el` makes the buffer with `generate-new-buffer`, which inherits `default-directory` from the buffer current at that moment, and nothing sets it afterwards, though the summary it is handed carries the session's `:cwd`.
The picker makes it worse: `agentpane-sessions` reuses one `*agentpane sessions*` buffer via `get-buffer-create`, whose directory is fixed at its first creation and never updated as it is re-listed for other projects, and transcripts opened from it inherit that.
The composer, made in `agentpane-prompt`, inherits from its transcript and needs nothing of its own once the transcript is right.

## The change

Set each transcript buffer's `default-directory` to `(file-name-as-directory (plist-get summary :cwd))` when `agentpane--transcript-buffer` creates it.
All three creation paths go through that function — opening from the picker, `agentpane-fork` and `agentpane-new-session` — and each passes a summary carrying `:cwd`.
agentpane is loopback only (D8 in `docs/DESIGN.md`), so the cwd the server reports is a path on the machine Emacs runs on.
`agentpane-sessions` also sets the picker's `default-directory` to the project it lists when it lists one, where it already sets `agentpane--cwd`, so the picker stops carrying the first project's directory.
A summary with an empty `:cwd` is the one case to leave the inherited directory alone; `agentpane--buffer-name` already treats `:cwd` as possibly absent.

## Done when

`ert` tests in `emacs/agentpane-test.el`, run as that file's Commentary says, each red before the change:
- opening a transcript for a summary whose `:cwd` is a temporary directory, from a buffer whose `default-directory` is a different one, leaves the transcript's `default-directory` at the summary's, with the trailing slash;
- two transcripts for sessions in two different directories each have their own;
- `agentpane-sessions` run from a buffer in a project sets the picker's `default-directory` to that project's root.
The whole file green, with the pass count in `emacs/agentpane.el`'s Commentary updated.

## Close note

Landed in ed84191. `agentpane--transcript-buffer` in `emacs/agentpane.el` now sets a new transcript's `default-directory` to `(file-name-as-directory (plist-get summary :cwd))`, and keeps the inherited one when `:cwd` is nil or empty. The existing tests pass summaries with no `:cwd` key at all.
`agentpane-sessions` sets the picker's `default-directory` to the project it lists. With the prefix argument (every session) it leaves the directory as it was.
Verified with three new ert tests in `emacs/agentpane-test.el`:
- `agentpane-test-transcript-takes-its-sessions-cwd`
- `agentpane-test-transcripts-keep-their-own-cwd`
- `agentpane-test-picker-takes-the-projects-root`
Each failed at its `default-directory` assertion against the pre-change `agentpane.el`. The whole file then ran 70 of 70, and the Commentary's pass count was updated to match.
One trap for future picker tests: `agentpane-sessions` ends with `pop-to-buffer`, so a later `(let ((default-directory ...)) (agentpane-sessions))` binds the picker's own variable and undoes the setq. The test runs each call inside `with-temp-buffer` for that reason.
