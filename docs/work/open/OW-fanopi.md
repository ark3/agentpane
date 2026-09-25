---
labels: [deferral, emacs]
---

# The visual-wrap width memo agentpane--insert-html keeps lives for one text part, so a full redraw still measures each list marker once per text part, about 142 calls where one memo per redraw would make 24

Found 2026-09-25 while landing OW-johomo.
`agentpane--insert-html` in `emacs/agentpane.el` binds `string-pixel-width` over its `visual-wrap-prefix-function` pass to a memo keyed by `equal-including-properties`, made fresh for each text part; its docstring says why that memo is exact.
On the second full `agentpane--draw` of stored Claude session `42788f31` (199 nodes, 8,297 lines), in batch Emacs 31.1, byte-compiled, that pass made 142 `string-pixel-width` calls, down from 766, over only 24 distinct strings.
A memo shared by every text part of one redraw would bring that to about 24, roughly 118 fewer calls, or about 7–14 ms at the 60–120 µs a call measured in the owner's graphical Emacs (OW-tujula).
Left out of OW-johomo for simplicity: it means binding one variable around each place a redraw goes through, `agentpane--draw` and `agentpane--refit` among them, and the memo is exact only within one buffer and one frame, which a longer-lived memo would have to keep true.

Judged not worth blocking anything: the saving is small beside the rest of a redraw.
Worth doing only if a profile of a graphical redraw shows the visual-wrap pass still standing out.

## Done

A test in `emacs/agentpane-test.el` in the manner of `agentpane-test-list-rows-measure-once-per-text-part`, drawing two text parts with the same list markers, red at twice the one-part count against today's code and green at the one-part count, with `agentpane-test-text-part-hanging-indents` unchanged.
