---
labels: [change, emacs]
---

# agentpane-mode shows nothing while the helper's event stream is down and reconnecting, where the browser shows Connecting and Reconnecting

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's `status` in `src/client/App.svelte` shows "Connecting…" or "Reconnecting…" from `view.connection`, so a user can tell a quiet session from a dead stream.
The helper in `src/emacs/helper.ts` reconnects its stream silently on disconnect (the `onDisconnect` cases in `src/emacs/helper.test.ts`), and `emacs/agentpane.el` hears nothing about it.

This needs wire: a helper notification carrying the stream's connection state, added to `src/emacs/protocol.ts`, whose docblock says to raise a change to that frozen interface before making it.
The browser's behaviour is pinned by `src/client/App.test.ts` "reports reconnection and unsupported pending agent requests".

Done when a test in `src/emacs/helper.test.ts` sees the notification on a disconnect and again on the reconnect, and an ERT test in `emacs/agentpane-test.el` sees an attached buffer show the state and then clear it, both red before the change and green after.
