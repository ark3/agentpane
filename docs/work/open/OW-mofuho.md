---
labels: [change, d24, emacs]
blocked-by: [OW-kimaya, OW-danifa]
---

# The `renamed` event leaves both wires once both clients key a live session by its handle

Filed 2026-09-24 under D24 in `docs/DESIGN.md`; blocked by OW-kimaya and OW-danifa, the two clients that still read the event until they key by handle.
In service of one identity story on the wire.

## What goes

The `renamed` arm of `ServerEvent` in `src/shared/protocol.ts`; `Broadcaster.renamed` in `src/server/http/broadcaster.ts`; its emission in the identity-event handler in `src/server/http/session-manager.ts`; the `renamed` arm of `reduceServerEvent` in `src/client/session-state.ts`; `session/renamed` in `src/emacs/protocol.ts` and `src/emacs/helper.ts`, both the forwarded one and the one `sessions/attach` synthesizes; and its handler in `emacs/agentpane.el`.
`SseTestClient` in `src/server/http/testing/sse-client.ts` carries its own copy of the re-key logic, as OW-suhoto's body records, and loses it too.
D2's paragraph beginning "One thing building the transport added to the event union" and D9's "Three states" are rewritten to describe the handle, and the surviving mentions OW-suhoto's close note lists, in `src/server/http/app.ts` and `docs/HANDOFF.md` finding 41, are read again and kept only as history.

## Amended 2026-09-25, at execution

Checked against the source at fecd985.

The emission is at two sites, not one: `SessionManager.#rename` when `announce` is set, and the tail of `SessionManager.#start` for a rename inside `start()`.
`Broadcaster.renamed` also calls `broadcastSnapshot(session.handle)`, and that snapshot is load-bearing: it is how every client learns the new ref under the handle, so both sites keep `sessionsChanged()` and a snapshot under the handle, and lose only the `renamed` frame.
The hold in `#rename`'s docblock -- `announce` false inside `start()` so a start that fails after renaming leaves nothing on the wire -- then holds that snapshot rather than a `renamed`; whether the hold is still needed at all is the implementer's to settle and state.

agentpane-mode has one use of `session/renamed` that is not a re-key, and the card as filed did not name it.
`agentpane--notified-buffer`'s docblock in `emacs/agentpane.el` ends "That event is the only link from the asked-for ref to the handle before the reply, so whatever retires it from the wire (OW-mofuho) has to give a snapshot sent before the reply another route."
When an attach's reply names another ref than the one asked for, the helper's `sessions/attach` handler in `src/emacs/helper.ts` today notifies `session/renamed` and then the snapshot it holds, both before the reply; the buffer holds only the asked-for ref and no handle, and without the `renamed` that snapshot matches no buffer and is dropped.
The route that replaces it is the helper's to give -- for instance, writing the reply first and the held snapshot after it, so the buffer has the handle by the time the snapshot arrives -- and the `sessions/attach` contract in `src/emacs/protocol.ts` and that docblock say what was chosen.
The ert test `agentpane-test-attach-renamed-before-its-reply-draws-the-snapshot` in `emacs/agentpane-test.el` pins the case today and is rewritten for the new route, not deleted.

The done condition's grep was too broad: "renamed" is also an English word here, in `docs/DESIGN.md` ("it is renamed aside"), `emacs/agentpane.el` ("A composer taken as this buffer's own is renamed after this buffer") and many test names and locals, none of them the event.
It is narrowed below to the event's own spellings, and prose that describes the retired event in the past tense -- D24's record of this card among it -- is history and may stay.

## Done when

- `rg -n '"renamed"|session/renamed|\.renamed\b|`renamed`' src emacs docs/DESIGN.md docs/WORKSTREAMS.md` finds only past-tense history, and no code, test or present-tense contract naming the event; `docs/MANUAL_TESTING.md` and the closed cards keep their history.
- The vertical-slice test for a rename at attach (`vertical-slice.test.ts`, "follows a materialised id when renamed is immediately followed by a snapshot") asserts the snapshot under the handle carries the new ref and that no `renamed` arrives, red against a server still emitting it.
- A helper test and the ert test above show an attach answered under a new ref still draws its snapshot in the buffer that asked, with no `session/renamed` on the wire.
- `bun run check` green and ert green.
