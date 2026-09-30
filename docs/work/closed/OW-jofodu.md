---
labels: [deferral, emacs]
closed: moot
---

# The Emacs helper keeps a pending attach by ref, so a detach from one buffer drops the wait of another buffer's attach of the same ref

Found 2026-09-25 by the implementer of OW-danifa, confirmed by reading `src/emacs/helper.ts`, not reproduced; left because it takes two buffers on one ref and a kill inside the other's attach round trip.
In service of every attach Emacs sends ending with its buffer hearing the session, whatever another buffer does meanwhile.

## What happens

The helper's `pending` is a set of `sessionKey`s, one per ref an attach asked for, not one per request.
`forget` in `src/emacs/helper.ts` deletes the ref from `pending` on every `sessions/detach` and `sessions/close`, with a handle or without, and the `sessions/attach` handler records its attachment only `if (pending.delete(key))`.
So with buffer X holding handle H at ref R and buffer Y's attach of R in flight, killing X (`agentpane--detach` in `emacs/agentpane.el` sends `sessions/detach` with H) also deletes Y's pending entry; Y's reply then records nothing, and Y, which counts itself attached, hears nothing until `g`.
The converse also holds: a buffer holding H that refetches (`agentpane-refetch` attaches again) and is killed before the reply leaves a reply that finds its entry gone, or, with the entry left, one that re-records an attachment no buffer holds.

`sessions/close` reaches the same `forget`, and the adversarial read of OW-dakeyi on 2026-09-28 named its case, read and not run.
OW-dakeyi made a close in flight state the closing buffer owns (`agentpane--closing` in `emacs/agentpane.el`), which no other buffer on that ref reads: kill the closing buffer and reopen the session from the picker, or use a second buffer on the ref (the D24 preview left beside a renamed live buffer), and its `C-RET` or `f` sends `sessions/attach` while the close is still out.
The server's `attach` waits out the disposal and spawns afresh (the `#disposing` wait in `SessionManager.attach`, `src/server/http/session-manager.ts`), which is that buffer's own intent; but the helper's close runs `forget` once `api.close` returns, deleting the new attach's `pending` entry, so the reply records nothing and the reopened buffer hears nothing — the stranded attach OW-dakeyi was filed for, reached from outside the closing buffer.
The same holds for a close that times out on the Emacs side and a `g` after it.
The per-request `pending` above fixes this case too, since the close's `forget` carries its handle.

## A direction, not a prescription

Per "Evidence" in `AGENTS.md`, a second guard in `forget` is not the fix; the owner of a pending wait is the request, so `pending` would hold one entry per attach rather than per ref, with a detach carrying a handle touching no one else's wait.
OW-danifa's close note records why a detach without a handle still goes by ref.

## Done when

A test in `src/emacs/helper.test.ts`, red first against the helper as OW-danifa left it: attach R and receive its snapshot under H, send a second `sessions/attach` for R and hold its REST reply, send `sessions/detach` for R carrying H, release the reply, and a later event under H reaches Emacs.
A second test in the same file, red first too: attach R under H, send `sessions/close` for R carrying H and hold its REST reply, send `sessions/attach` for R, release the close and then the attach's reply under a fresh handle, and a later event under that fresh handle reaches Emacs.
`bun run check` green.

## Close note

Superseded by OW-wukako (2026-09-30, 0da9e24), which carried this card's flaw with OW-savafi's.
agentpane-mode now mints a token per attach and sends it on the attach and on every sessions/detach and sessions/close; `forget` in src/emacs/helper.ts gives up only the attach that token names, and a handle alone gives up none.
Both of this card's done-condition cases are vitest cases in src/emacs/helper.test.ts under "the attach token (OW-wukako)" (a detach by handle while another buffer's attach of the ref is held, and a close carrying the handle racing a new attach), each shown red against the pre-OW-wukako helper by the adversarial read.
What remains of the by-ref match -- a detach without a handle whose token names no waiting attach -- is OW-linowe.
