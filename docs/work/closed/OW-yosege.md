---
labels: [change, emacs]
closed: done
---

# agentpane-mode has no command that closes a session's subprocess, as the browser's Tools Detach does; killing a buffer only stops its notifications

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's Tools → Detach (closed OW-tewave) runs `detachSession` in `src/client/App.svelte`, then `controller.detach` in `src/client/controller.ts`, which sends `DELETE /api/sessions/:backend/:id`.
That route kills the subprocess.
The transcript then stays on screen as a read-only preview when the listing says the session is `onDisk`; a session that is not, a virtual one or a fork before its first turn, clears the selection to the startup view instead (`controller.detach`, closed OW-vasubu).
The Emacs analogue of that second case is this card's to decide, since `sessions/preview` answers such a ref with an empty transcript rather than an error.
It is offered only while `detachable` holds: not while the session streams, sends, compacts, or has requests pending.

`emacs/agentpane.el` has no such command.
Killing a transcript buffer runs `agentpane--detach`, which sends `sessions/detach` and deliberately leaves the session running, "as closing a browser tab does" (its docstring); that stays as it is.
The helper already has `sessions/close` (`src/emacs/helper.ts`, `src/emacs/protocol.ts`), which kills the subprocess, and no elisp sends it.

The names collide: the browser's user-facing "Detach" is the helper's `sessions/close`, not its `sessions/detach`.
The new command must send `sessions/close`.

The browser's behaviour is pinned by `src/client/App.test.ts` "disables the composer's Detach for every case outside its enablement predicate" and "the composer's Detach tool detaches an attached selection", and by `src/client/controller.test.ts` "detaches the selected session onto its read-only preview".

Done when ERT tests in `emacs/agentpane-test.el` go red before the change and green after.
One sees the command send `sessions/close` and leave the buffer unattached and redrawn from `sessions/preview`, and one sees it refused in each case `detachable` refuses.
`emacs/fake-helper.ts` answers only `sessions/list` and `sessions/preview` and records no params, so these tests stub the request as `agentpane-test--forking` does, or extend the fake helper.

## Close note

Built `agentpane-close-session`, bound `C-c C-q` in `agentpane-transcript-mode`, in `emacs/agentpane.el`: the Emacs analogue of the browser's Tools → Detach.
It sends the helper's `sessions/close`, which kills the subprocess; killing a buffer still sends only `sessions/detach` and leaves the session running.
It refuses, sending nothing, in every case the browser's `detachable` refuses: not attached, streaming or compacting, a prompt or fork in flight, a request pending.
It also refuses an attach in flight, which the browser has no counterpart for.
A virtual or elsewhere-attached row opened from the picker is a preview in Emacs and cannot be closed; the adversarial read found the browser the same, since its Detach renders only outside the preview branch.
When the close answers, the buffer forgets its handle, its attach-sent flag, its attachment, its dropped flag and its turn-done watch.
The listing then decides what comes next: a session on disk is redrawn from `sessions/preview`, and one not on disk, or no longer listed, has its buffer killed, as the browser falls back to the startup view (OW-vasubu).
The adversarial read found that a `session/detached` arriving while the close was in flight left `agentpane--dropped` set, so the refetch re-attached and respawned the closed session; the fix clears it, with a test red first.
Verified by five ERT tests in `emacs/agentpane-test.el` built on the `agentpane-test--closing` macro, all red before the change.
The reader mutated the command 15 ways and every mutation turned a test red.
Full suite: 186 tests, 0 unexpected.
Filed from the review: OW-dakeyi, the wider in-flight close window, and OW-watawe, the draft lost when a buffer with nothing on disk is killed.
