---
labels: [change, emacs, d25]
closed: done
---

# The Emacs helper answers a sequence gap by re-attaching the session, which spawns it again when a close is out; a gap should detach that one session

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first.
The browser's half is OW-lunihe; the two land the same rule in each client.

## What happens

`onEvent` in `src/emacs/helper.ts` answers every entry of `reduceServerEvent`'s `recover` with `api.attach(ref)`, unconditionally (`for (const { ref } of result.recover) api.attach(ref)`).
That was OW-refibu's decision, "a seq gap is healed by an attach, not locally", and it spawns the session again when a `sessions/close` for it is out, which OW-wezaji, closed moot into this card, found with no guard in the helper.

## The change

A gap detaches that one session: the helper drops the attachment (`drop`) and tells Emacs by a `session/detached` under that handle, as `dropDead` does for a handle the server let go.
Nothing is attached on Emacs's behalf; the buffer comes back on `g`, which is deliberate.
The helper's docblock, which states OW-refibu's rule, says the new one.

## Done when

A test in `src/emacs/helper.test.ts`, red first, delivers an event whose `seq` skips one for an attached session, and asserts no `attach` reached the API and Emacs was sent `session/detached` for that handle.
`bun run check` passes.

## Close note

Built 2026-09-28: a `seq` gap in the Emacs helper now detaches that one session instead of answering with `api.attach` (D25 point 5), as OW-lunihe did for the browser.
`detachGapped` in `src/emacs/helper.ts` deletes the gapped view from the helper's reducer state and, where Emacs attached the handle, drops the attachment and sends `session/detached` under it, as `dropDead` does; nothing attaches on Emacs's behalf, and `g` brings the buffer back.
`session/detached`'s entry in `src/emacs/protocol.ts` records the second cause as the interface's eighth raise, and every copy of the old attach-on-gap rule was retired: the helper docblock, `Recovery` in `src/client/session-state.ts`, `broadcaster.ts`, `ServerEvent` in `src/shared/protocol.ts`, D3's bullet in `docs/DESIGN.md`, `agentpane.el` docstrings, and the `sse-client.ts` test stand-in.
Verified by `src/emacs/helper.test.ts`: "detaches a session whose seq gaps, attaching nothing, and says nothing more under it until Emacs attaches it again (OW-filuge)" failed against the old code with no `session/detached` sent, and failed again when the attach was put back; "sends nothing from the gapped view when the attach after it is answered under the rename the gap swallowed (OW-filuge)" failed when the view deletion was removed.
`bun run check` passes, and the ert suite passes.
The adversarial read found two things this left open, both filed: OW-tifiva, where an attach reply that lands after the gap leaves the buffer attached and hearing nothing, and OW-puzome, where a gap mid-turn raises agentpane-mode's turn-done indicator though the turn goes on.
