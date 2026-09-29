---
labels: [change, emacs, sweep-0929]
---

# The Emacs helper matches an attach to its reply and snapshot by ref, not by request, so a detach from one buffer abandons another's attach and an attach can be fed an older container's dead handle

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
It is meant to supersede OW-jofodu and OW-savafi, two symptoms of the same matching.

## Where attaches are matched by ref

In `src/emacs/helper.ts`, around the `Attaching` records OW-rebawa introduced:
- `introduce` answers an unanswered attach that holds no handle yet by `sessionKey(attach.asked) === key`;
- `forget` abandons every unanswered attach of the ref (`sessionKey(attach.asked) === key`), even when the detach it serves carries a handle.
In `emacs/agentpane.el`, `agentpane--notified-buffer` binds the resulting snapshot to a buffer holding that ref that sent an attach and holds no handle.

OW-jofodu's body predates OW-rebawa and names a `pending` set that no longer exists; its flaw survives in `forget`, where the victim now ends honestly not attached instead of counting itself attached over silence.
OW-savafi's flaw is on the server side of the same match: `SessionManager.attach` in `src/server/http/session-manager.ts` broadcasts one snapshot per startup and concurrent attaches collapse onto it, so the helper cannot tell which container a snapshot under that ref answers.

## The change

Correlate each attach by a per-request token instead of by ref.
Between Emacs and the helper alone it settles OW-jofodu: a detach with a handle stops touching other buffers' attaches, and a detach without one names its own.
Settling OW-savafi also needs the server to echo the token on the snapshot that attach causes, which would retire the helper's `seen` and `release` guessing and the case D25 admits it "can misjudge".

That echo is a wire change, and D25 decision 1 in `docs/DESIGN.md` has already judged a similar field "not worth a wire field" for requests other than attach.
So decide first, and record in D25 either way, whether the server echo is worth it; if not, this card does the Emacs-to-helper token only, and OW-savafi keeps its own guard (compare handles at the reply) and stays open.
The wire change lands on both wires or neither, per the Both clients rule in `AGENTS.md`: the HTTP API and `src/emacs/protocol.ts`.

OW-zavehi may retire `agentpane--dropped` and change what `g` does on an unattached buffer; read its outcome first if it has closed.

## Done when

Tests in `src/emacs/helper.test.ts`, red first: two buffers attach the same ref, one detaches by handle, and the other's attach is answered and bound; and, if the echo is taken, an attach answered after another client closed the container under that ref binds the new handle, not the dead one.
An ERT test in `emacs/agentpane-test.el` for the two-buffer case at the Emacs end.
Then OW-jofodu closes `--moot`, and OW-savafi closes `--moot` or is amended to its guard, each citing this card.
