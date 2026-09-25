---
labels: [deferral, emacs]
---

# agentpane--fit-header measures a header in the selected frame, not the frame whose window it is fitted to, so a transcript shown only on another frame is cut to the wrong width

Found 2026-09-25 by the adversarial read of OW-tujula, from reading `emacs/agentpane.el` only; no multi-frame run with differing fonts was made.
`agentpane--fit-header` fits to `agentpane--window-width`, the body width of `agentpane--fit-window`: the narrowest window showing the transcript, on any frame.
But it subtracts the *selected* frame's `frame-char-width` from that width, and measures each candidate with `string-pixel-width`, whose `buffer-text-pixel-size` lays text out in the selected window and so in the selected frame's fonts.
When the transcript is shown only on a frame other than the selected one, with a different font or on a different terminal, width and measure disagree with where the header is drawn.
The reader's worked case: an emacs daemon with a tty client selected and the transcript shown only in a graphical client's window 720 px wide; the width is taken as 719 "pixels" and `fits` counts tty cells, so the search keeps about 700 characters of summary where the window shows about 79.

OW-tujula did not fix this; it kept the new `vertical-motion` path from diverging further: `agentpane--motion-window` answers nil unless the fit window is on the selected frame, and its docstring says why.
If the measure moves to the fit window's frame, that condition is what this change retires, and `agentpane-test-motion-only-on-the-selected-frame` in `emacs/agentpane-test.el` with it.

## Done

A test in `emacs/agentpane-test.el` that shows the transcript only on a second frame whose character width differs from the selected frame's goes red first and green after, asserting the drawn header fits that frame's window.
Two tty frames on one terminal share a character width, so the test needs frames that differ; if no batch or tty setup can make that, the close note says so and says how the fix was checked instead.
