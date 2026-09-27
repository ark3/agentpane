---
labels: [deferral, emacs]
closed: done
---

# agentpane-mode's global finished-turn tables keep every handle the server ever listed, and a new picker wipes the streaming levels a second live picker still reads

Found by the adversarial read of OW-yufahi on 2026-09-26 and judged not worth blocking that card: each is a nit with no user-visible effect in the ordinary single-picker use.
Before OW-yufahi (commits deb733a and c61a024) the tables were buffer-local to the picker and died with it; now `agentpane--listed-streaming` and `agentpane--finished-turns` in `emacs/agentpane.el` are global.

1. Nothing removes a handle the server has let go of from either table.
   Handles are never reused (`#handlePrefix` in `SessionManager`, `src/server/http/session-manager.ts`, is fresh for each server process), so an entry is never drawn, but `agentpane--clear-seen-turns` re-checks every mark on each call, and the tables grow for the life of the Emacs session.
   The reader measured 2.1 ms per call with 5 marks and 100 transcript buffers in batch Emacs 31.1.
   Since OW-piweyi (2882af8, 3b041ea, 2026-09-27) that function runs from the global `window-state-change-functions` instead of from each notification, so while any mark is outstanding it runs on every window-state change on any frame: each `C-x o`, minibuffer entry and exit, resize, and twice per frame switch; `agentpane--binding-changed`, the variable watcher on `agentpane--handle` and `agentpane--session`, flags a further run on each write to either while the buffer is shown.
   OW-piweyi's adversarial read measured it byte-compiled on Emacs 31.1 at about 330 µs per call with 5 marks and 120 buffers, and 2.7 ms with 10 marks and 500 buffers, because `agentpane--seen-p` scans `buffer-list` twice per mark; with no marks a call costs about half a microsecond, which is what the `agentpane--clear-seen-turns` docstring states.
   A mark never dropped therefore now costs on every window change, not only on a notification.
   Since the picker now asks `sessions/list` for every session, `agentpane--note-turns` could drop any handle its listing no longer carries.
2. `agentpane-sessions-mode` runs `(clrhash agentpane--listed-streaming)` so a picker created after none existed does not read a turn that ended meanwhile as ended unseen.
   With a second live picker (a renamed or cloned `*agentpane sessions*`), that also wipes the levels the first still relies on, so a turn ending before the new picker's first reply loses its mark.
3. The picker's listing is now unfiltered and is re-requested at every `sessions/changed`, so the reply carries every stored session on the machine; its size and Emacs's parse time were not measured (`agentpane--refetch-sessions`).

Done when any of these is either fixed with an ERT test in `emacs/agentpane-test.el` that fails first, or measured and declined in the owning docstring.

## Close note

All three findings in the card are resolved in emacs/agentpane.el: the first two are fixed and the third is measured and declined.
1. `agentpane--note-turns` now drops from both tables every handle its listing doesn't carry. The listing is always unfiltered (`agentpane--refetch-sessions` is the only caller and sends no params), and `SessionManager.list` lists every held container under its handle, so an absent handle is one the server let go. ERT test `agentpane-test-picker-forgets-a-handle-the-server-let-go` fails against the previous code and passes now.
2. The `clrhash` at picker creation is gone. `agentpane--picker-gone` runs from each picker's buffer-local `kill-buffer-hook` and `change-major-mode-hook` and empties the levels only when no other picker remains, so the clear happens when the levels stop being fed rather than when a picker is made. ERT tests: `agentpane-test-new-picker-keeps-the-levels-a-live-picker-reads` fails against the old creation-time clear. `agentpane-test-picker-gone-keeps-the-levels-another-picker-reads` was added after the adversarial read showed a plain unguarded clrhash still passed the suite; it fails against that substitute. `agentpane-test-new-picker-does-not-mark-a-turn-that-ended-with-no-picker` was extended to cover a mode change, and it fails with either hook removed.
3. Measured on the home server on 2026-09-27 with Emacs 31.1 and jsonrpc.el 1.0.29. There were 369 stored sessions, and the reply was 116 KB. The helper round trip took 207–277 ms, with the server alone at 205–222 ms and a filtered request at 194–229 ms. Emacs parsed the reply in about 0.8 ms. Filtering was declined in the `agentpane--refetch-sessions` docstring, and the section "What the picker's unfiltered listing costs (OW-wazipa)" in docs/MANUAL_TESTING.md carries the numbers and the reproduction script.
The full ERT suite passes (140 tests, 3 skipped as before), and byte-compiling produces no warnings.
The adversarial read named one case the item-2 guard misses, which the old code also missed: a picker stays open while its listings fail, so the levels go stale. It is filed as the ownership-change sibling OW-vehuji. The browser's counterpart of item 1 is filed as OW-nodade.
