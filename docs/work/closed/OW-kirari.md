---
labels: [change, emacs]
blocked-by: [OW-nufafi]
closed: moot
---

# agentpane-mode's picker takes a row's streaming dot from its last listing, so the dot goes stale when a turn starts or ends

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

Each browser sidebar row reads `view.state.sessions[key]?.isStreaming` and falls back to the listed summary only for a session with no live state (OW-furinu), so the dot follows the turn.
`agentpane--session-entry` in `emacs/agentpane.el` reads `isStreaming` from the summary the last `sessions/list` returned, and a turn starting or ending fires no `sessions/changed`, so the dot stays as listed.

The wire does not carry this for a session no buffer has attached.
The helper in `src/emacs/helper.ts` reduces every event on its stream but notifies Emacs only for attached handles, so this needs a status notification for every session, or one scoped to streaming changes, added to `src/emacs/protocol.ts`.
It is blocked by OW-nufafi because before that card the helper has no stream to forward from until something attaches.

The browser's behaviour is pinned by `src/client/App.test.ts` "takes the row's dot from the live session map rather than the listed summary" and "clears the row's dot when the live session map says the turn ended".

Done when a test in `src/emacs/helper.test.ts` sees the new notification for a session no handle is attached to, and an ERT test in `emacs/agentpane-test.el` sees a picker row's dot set and then cleared by it, both red before the change and green after.

## Close note

Filed and closed the same day, 2026-09-26, by the OW-varevo parity survey, after that survey's adversarial reader found the card's premise false.
The card said a turn starting or ending fires no `sessions/changed`.
It does: `#onUpdate` in `src/server/http/session-manager.ts` broadcasts on every streaming change (OW-furinu), the helper forwards it, `agentpane--revert-pickers` re-lists, and the listed `isStreaming` is live.
The picker's dot is stale today only while the helper's stream is closed, before any buffer attaches, and OW-nufafi carries that.
The new status notification this card proposed is not needed.
OW-metuko, which was blocked on this card, now waits on OW-nufafi instead.
