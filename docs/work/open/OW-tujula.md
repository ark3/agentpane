---
labels: [change, emacs]
---

# agentpane--fit-header binary-searches each folded header with string-pixel-width, about eight layouts a header, where one vertical-motion to a pixel column finds the same cut

Found 2026-09-25, while measuring why a send stalls agentpane-mode on a long transcript (OW-yirosu).
`agentpane--fit-header` in `emacs/agentpane.el` fits each folded tool and thinking header to one screen line, the rule OW-gageru set; the summary is what gives way, cut with `…`.
When the whole header does not fit, it binary-searches the summary's length, building a fresh candidate string at each step and measuring it with `string-pixel-width`, which lays the string out in a work buffer each time.

## What it costs

Measured in batch Emacs 31.1 on 2026-09-25, byte-compiled, on the second full `agentpane--draw` of two stored Claude sessions, with `string-pixel-width` and `agentpane--fit-header` wrapped in counting advice:
- 348 messages, 8,298 lines: 153 headers, 144 of them cut short, 1,279 `string-pixel-width` calls from inside `fit-header` (8.4 per header), 88 ms of a 262 ms draw.
- 176 messages, 3,474 lines: 103 headers, 76 cut short, 687 calls (6.7 per header), 46 ms of a 78 ms draw.
Batch has no fonts: the window was 80 pixels wide, one per column, and each call measured character cells.
In the owner's graphical Emacs the per-call cost was about twice that, not an order of magnitude more; see "The one-pass measure".
How many headers a wider window cuts, and so how often the search runs at all, was not measured.
Every full redraw pays this: a snapshot, and the `agentpane--refit` that `agentpane--refit-on-resize` schedules on a width change.

## The one-pass measure

`vertical-motion` accepts `(COLS . 0)` with a float COLS, in units of the frame's canonical character width, and stops "at the position closest to that pixel coordinate" on a line that mixes fonts or uses variable-pitch (its docstring); it works in the current buffer, whatever the window shows.
In a tty Emacs 31.1 on 2026-09-25, run with `script -qc "emacs -nw -Q …"` so it had a real terminal frame, one `vertical-motion` over a 380-character header landed on exactly the cut the binary search found at 10, 40 and 79 columns of an 80-column window.
Two limits showed up in the same probe:
- In `emacs --batch`, whose frame is on `initial_terminal`, `vertical-motion` did not move at all and returned 0; the ERT suite runs in batch, so it cannot exercise this path, and `fit-header` needs a measure batch can run as well.
- At 150 columns, wider than the window, it stopped at 79: it moves within one screen line of the window whose parameters it uses, so the text wraps at that window's width, and the selected window is not necessarily the narrowest one showing the transcript, which is what `agentpane--window-width` fits to.
The same day, with the owner's permission, the probe ran in the owner's running Emacs on the home server over `emacsclient --eval`: GNU Emacs 31.1, a GTK frame, `variable-pitch` set to IBM Plex Sans and `default` to IBM Plex Mono, `frame-char-width` 9.
It drew nothing: a `with-temp-buffer` with `(buffer-face-set 'variable-pitch)`, as `agentpane-transcript-mode` sets `agentpane-prose`, which inherits `variable-pitch`, held the header, and `vertical-motion` was passed the selected window, a magit window 1,904 px wide showing another buffer.
agentpane was not loaded there, so `shadow`, `success` and `bold` stood in for the marker, state and tool-name faces, and the ellipsis-and-tail step was left out.
Three summaries -- a 183-character shell command, a 196-character prose sentence, and a 111-character path padded with runs of `W`, `i` and `m` -- were each fitted at 300, 700 and 1,200 px and at the window's width less one character:
- In all 12 cases the `vertical-motion` cut equalled the binary search's, the prefix it chose fitted, and one character more did not; no overshoot occurred, which does not show that none can.
- The binary search took 7–8 `string-pixel-width` calls and 0.40–0.99 ms a header, 1.79 ms on the first, cold call, which is 60–120 µs a call against batch's 45 µs.
  That search ran in full even where the whole header fitted, where `fit-header` takes its one-call fast path, so the widest rows overstate today's cost.
- One `vertical-motion` took 0.07–0.18 ms a header, growing with the target column.
So a window showing another buffer serves as the measuring window, with the fonts taken from the current buffer's face remapping; it still wraps at that window's width.

## The change

Cut each header with as few layouts as a real display allows: one `vertical-motion` to the pixel column where the summary must end, after one measurement of what follows the summary (the ellipsis and any tail), and one for the fast path where the whole header fits.
Load-bearing:
- The cut is the one the current search finds: the longest start of the summary that fits beside the ellipsis and the tail, which is left off when it would not fit beside an ellipsis alone, as `fit-header`'s docstring says.
  "Closest to that pixel coordinate" may land one character past the last one that fits, so the result is checked and stepped back where it overshoots.
- The measure uses the transcript's face remapping, as the `(current-buffer)` argument to `string-pixel-width` does today, and wraps at no narrower width than the one it fits to.
- Batch, where `vertical-motion` does not move, keeps a measure that works there, the current search or any other, and the existing header tests under ";;;; Fold headers: one screen line each" in `emacs/agentpane-test.el` stay green unchanged.
The close note states how many layouts a cut header costs, and whether the new path was checked in a graphical frame or only a tty.
The owner permits one-off probes in their running graphical Emacs on the home server over `emacsclient --eval` (2026-09-25), as the probe above did, but no test and no command in the Commentary may depend on it: the checked-in tests stay in tty and batch Emacs.

Out of scope: `visual-wrap-prefix-function`, called by `agentpane--insert-html` over each text part, made the other 1,119 `string-pixel-width` calls in the larger draw.

## Done

Red first, then green, in `emacs/agentpane-test.el`: with `string-pixel-width` (and whatever the new measure calls) counted by advice, drawing a tool whose summary is ten times the fitted width costs at most three measurements, where the current search costs about eight.
Since `vertical-motion` needs a real display, that test and one asserting the new cut equals the binary search's on a mix of summary lengths run in a tty Emacs, not batch, and the Commentary of `emacs/agentpane.el` gives the command that runs them.
The batch suite passes as that Commentary gives it, with its pass count updated.
