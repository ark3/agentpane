---
labels: [change, emacs]
closed: done
---

# agentpane-mode shows nothing while the helper's event stream is down and reconnecting, where the browser shows Connecting and Reconnecting

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's `status` in `src/client/App.svelte` shows "Connecting…" or "Reconnecting…" from `view.connection`, so a user can tell a quiet session from a dead stream.
The helper in `src/emacs/helper.ts` reconnects its stream silently on disconnect (the `onDisconnect` cases in `src/emacs/helper.test.ts`), and `emacs/agentpane.el` hears nothing about it.

This needs wire: a helper notification carrying the stream's connection state, added to `src/emacs/protocol.ts`, whose docblock says to raise a change to that frozen interface before making it.
The browser's behaviour is pinned by `src/client/App.test.ts` "reports reconnection and unsupported pending agent requests".

Done when a test in `src/emacs/helper.test.ts` sees the notification on a disconnect and again on the reconnect, and an ERT test in `emacs/agentpane-test.el` sees an attached buffer show the state and then clear it, both red before the change and green after.

## Close note

The Emacs helper now tells Emacs when its event stream is down, and agentpane-mode shows it, as the browser's status line says Reconnecting.

Wire: a new unfiltered notification `stream/changed` `{ state: "reconnecting" | "connected" }` (no `session`, no `handle`, since one stream serves every session), raised as the seventh change to the frozen interface in `src/emacs/protocol.ts`.
`src/emacs/helper.ts` `openStream` sends `"reconnecting"` on a drop or a failed open, once per outage however many reopens fail (a `down` flag recording what Emacs was last told), and `"connected"` on the open that ends it, ahead of that open's `sessions/changed` where it sends one.
No `"connecting"` state for the first open: Emacs reads the stream as up until told otherwise, and an attaching buffer draws nothing live before that open's snapshot anyway.

Emacs: `emacs/agentpane.el` holds a global `agentpane--stream-down`, and an attached transcript buffer's mode line leads with `reconnecting` (warning face) while it is set.
The adversarial read found stale mode lines around attach and detach mid-outage and across a helper exit; the fix routes every write of `agentpane--attached` through `agentpane--hold-attached` and of the stream flag through `agentpane--hold-stream-down`, each of which redraws, so the redraw lives where the state changes.

Verified: `src/emacs/helper.test.ts` "says the stream is reconnecting once when it drops, however many reopens fail, and connected when one opens" and "...when its very first open fails, and connected when a reopen succeeds"; ERT `agentpane-test-stream-down-shows-reconnecting-until-it-is-back`, `...-stream-back-clears-reconnecting-from-a-buffer-detached-meanwhile`, `...-attach-answered-during-an-outage-shows-reconnecting`, `...-reconnecting-leaves-a-buffer-detached-meanwhile-and-the-next-helper` -- each shown red against the unfixed code or a targeted mutation, then green.
Five existing helper reconnect tests had their exact notification lists extended by the two new frames, none loosened.
`bun run check` passed (1463 tests); ERT 181 tests, 0 unexpected, 3 tty skips.

Left for OW-sosape: when the stream's very first open fails, the open that ends that outage sends `connected` but no `sessions/changed`, because `opens` counts only successful opens -- predates this card; `protocol.ts` documents the exception until that card lands.
Not done: the picker (`agentpane-sessions-mode`) shows no stream state; the card asked only for attached buffers.
