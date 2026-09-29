---
labels: [deferral, emacs, sweep-0929]
---

# agentpane-mode's streaming levels outlive a gap in the picker's listings: a sessions/list that fails while a picker stays open leaves them stale, and the next listing marks a turn that ended in the gap, watched or not

Found by the adversarial read of OW-wazipa on 2026-09-27; low severity, and the same miss existed before that card.
Under the AGENTS.md rule on a guard whose adversarial read names a case it misses, this is the sibling, authored as the ownership change for the levels.

`agentpane--listed-streaming` in `emacs/agentpane.el` holds the streaming level the last listing read for each handle, and `agentpane--note-turns` marks a session when a listing reads it done after one that read it streaming.
The levels are only meaningful while listings land continuously: a turn that ends in a gap between two listings is marked whether or not the user watched it end.
Since OW-wazipa, `agentpane--picker-gone` (run from each picker's `kill-buffer-hook` and `change-major-mode-hook`) empties the levels when the last picker goes, guarded by a `seq-some` over `buffer-list` for another picker.
That guard covers the gap "no picker exists" and misses the gap "a picker exists but no listing lands": every `sessions/list` that `agentpane--refetch-sessions` sends (through `agentpane--request`) errors or times out, while the transcript buffers' own notifications still flow, and the first listing that succeeds afterwards reads a turn that ended in the gap, watched or not, as ended unseen.
Where the helper's event stream is down too, transcripts got no events either, and marking those turns is arguably right; the true miss is only "listings fail, notifications work".

The ownership change: make the levels' validity belong to the continuity of the listing feed, so that any break in it — the last picker going, or a listing that fails — invalidates them from one place, and `agentpane--picker-gone`'s `seq-some` guard retires into it.
Read the `agentpane--picker-gone` and `agentpane--note-turns` docstrings first; they state why the levels are cleared and why marks are kept.
Check how `agentpane--request` reports a failed or timed-out request to its caller before choosing the shape.

Done when an ERT test in `emacs/agentpane-test.el`, using the stub `agentpane-test--listing` under ";;;; The picker's finished-turn mark, against a stub connection", fails a listing between one that reads a session streaming and one that reads it done, and asserts no mark — red before, green after — with `agentpane-test-new-picker-does-not-mark-a-turn-that-ended-with-no-picker` and `agentpane-test-picker-gone-keeps-the-levels-another-picker-reads` still green.
Or: measured as not worth it and declined in the `agentpane--listed-streaming` docstring.

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) found one more gap in the listing feed this card does not name: a helper that dies over a live server.
`agentpane--listed-streaming` is cleared only in `agentpane--picker-gone`, so the levels a picker held survive `agentpane--helper-gone` just as they survive a failed `sessions/list`, and the next listing through a new helper marks a turn that ended in between.
Whatever owner this card settles on for those levels should cover that case too, with its own ERT test.
