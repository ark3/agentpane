---
labels: [deferral, emacs]
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
