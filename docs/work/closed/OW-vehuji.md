---
labels: [deferral, emacs, sweep-0929]
closed: done
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

## Close note

Landed in df0e29a and 2273dd0 (emacs/agentpane.el, emacs/agentpane-test.el; Emacs only, no src/ change).

What was built: the streaming levels' validity now belongs to the continuity of each picker's listing feed, decided in one place, `agentpane--refetch-sessions`.
A buffer-local `agentpane--listed-through` in each picker holds the connection its listings are unbroken through.
A listing records the connection it goes out on; it joins the feed as it goes out when some picker is then unbroken through that connection; when it lands it keeps `agentpane--listed-streaming` only if its picker is unbroken through the connection it went out on, and otherwise empties the levels first.
Its FAILED breaks the picker only while it is still the picker's latest listing (`agentpane--latest-listing` token), so a superseded failure breaks nothing.
The three breaks reach that check with no hook of their own: the last picker going takes its variable with it, a latest listing failing sets it nil, and a helper death leaves every picker naming a torn-down connection the next helper's never matches.
`agentpane--picker-gone`, its two hooks and its `seq-some` guard are gone.

Verified: ERT tests for a failed listing and for a helper death between a streaming and a done listing, each red on 6a25fec and green after; the adversarial read of the first cut found three mark losses relative to 6a25fec (a picker killed before a second's first listing lands, a superseded listing failing, a reply landing after the helper's teardown), each now covered by a test red on the first cut and green after, plus a test that one picker's failed listing keeps the levels another reads.
`agentpane-test-new-picker-does-not-mark-a-turn-that-ended-with-no-picker` and `agentpane-test-picker-gone-keeps-the-levels-another-picker-reads` stay green; full suite 247 tests, 244 as expected, 3 skipped (skipped on main too).

One loss is left and stated in the `agentpane--listed-through` docstring: a listing that goes out while no picker is unbroken empties the levels as it lands, even if another picker's listing landed meanwhile, so a turn that ended within that one round trip (about 0.2 to 0.3 s on the home server, per OW-wazipa's measurement) loses its mark; closing it would need ordering across pickers' listings.
