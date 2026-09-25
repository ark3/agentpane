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

## Done when

- `rg renamed src emacs docs/DESIGN.md docs/WORKSTREAMS.md` finds nothing; `docs/MANUAL_TESTING.md` and the closed cards keep their history.
- The vertical-slice test for a rename at attach asserts the snapshot under the handle carries the new ref and that no `renamed` arrives, red against a server still emitting it.
- `bun run check` green and ert green.
