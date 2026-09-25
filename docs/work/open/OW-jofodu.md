---
labels: [deferral, emacs]
---

# The Emacs helper keeps a pending attach by ref, so a detach from one buffer drops the wait of another buffer's attach of the same ref

Found 2026-09-25 by the implementer of OW-danifa, confirmed by reading `src/emacs/helper.ts`, not reproduced; left because it takes two buffers on one ref and a kill inside the other's attach round trip.
In service of every attach Emacs sends ending with its buffer hearing the session, whatever another buffer does meanwhile.

## What happens

The helper's `pending` is a set of `sessionKey`s, one per ref an attach asked for, not one per request.
`forget` in `src/emacs/helper.ts` deletes the ref from `pending` on every `sessions/detach` and `sessions/close`, with a handle or without, and the `sessions/attach` handler records its attachment only `if (pending.delete(key))`.
So with buffer X holding handle H at ref R and buffer Y's attach of R in flight, killing X (`agentpane--detach` in `emacs/agentpane.el` sends `sessions/detach` with H) also deletes Y's pending entry; Y's reply then records nothing, and Y, which counts itself attached, hears nothing until `g`.
The converse also holds: a buffer holding H that refetches (`agentpane-refetch` attaches again) and is killed before the reply leaves a reply that finds its entry gone, or, with the entry left, one that re-records an attachment no buffer holds.

## A direction, not a prescription

Per "Evidence" in `AGENTS.md`, a second guard in `forget` is not the fix; the owner of a pending wait is the request, so `pending` would hold one entry per attach rather than per ref, with a detach carrying a handle touching no one else's wait.
OW-danifa's close note records why a detach without a handle still goes by ref.

## Done when

A test in `src/emacs/helper.test.ts`, red first against the helper as OW-danifa left it: attach R and receive its snapshot under H, send a second `sessions/attach` for R and hold its REST reply, send `sessions/detach` for R carrying H, release the reply, and a later event under H reaches Emacs.
`bun run check` green.
