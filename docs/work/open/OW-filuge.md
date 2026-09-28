---
labels: [change, emacs, d25]
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
