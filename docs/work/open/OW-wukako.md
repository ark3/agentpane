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

## Amended 2026-09-29 by OW-likopo

Since OW-likopo, `sessions/attach` in `runHelper` (`src/emacs/helper.ts`) enters its `Attaching` record, then awaits `openStream()` before `api.attach`.
A `sessions/detach` of the asked-for ref that lands while that first open is pending abandons the attach through `forget`, but the handler still sends the REST attach once the open settles, which spawns the session nobody is waiting on; the reply then goes out with nothing recorded.
This is not a regression: before OW-likopo that REST call had already gone out.
It is the same attach-to-request matching this card owns, so whatever token replaces the ref match should also let an attach abandoned during the open send no REST call; add that case to the helper test above, holding the open with the fake source's `holding` flag and `openHeld()`.

## Amended 2026-09-30 at execution: the echo is declined, and the ref match goes instead

A cold read at execution found a third design beside the two above, and this card takes it.
The attach's REST reply already names the handle of the container that attach landed on (`sessionRoute`'s GET in `src/server/http/app.ts` answers `summaryOf(ref)`), and the `sessions/attach` handler already answers at the reply from the view the reducer holds under `summary.handle`, or waits for the snapshot under it.
OW-savafi's wrong answer comes only from `introduce` answering an attach whose reply has not come by `sessionKey(attach.asked) === key`; with that clause gone, an attach is answered only under the handle its reply names, and a snapshot under another handle of the same ref answers nothing.
A snapshot that beats its reply costs nothing: the reducer holds its view, upserts meanwhile included, and the reply answers from it.
So no server echo is taken, and nothing changes on the HTTP API.
What the echo alone would have added is telling apart, at a reply that finds no view but a snapshot `seen` under its handle, a gap that took this attach's own snapshot from one that took another's; that takes a lost or malformed frame, which D26 point 4 calls a server bug not to defend, and without the ref match it now reaches a same-ref attach as well as an alias's.
The echo would also have cost the frozen helper contract a wire field the server must carry (a token array on the snapshot, since concurrent attaches collapse onto one startup and one snapshot in `SessionManager.attach`), a rework of every attach in `src/emacs/helper.test.ts`, and a skew hazard: a new helper against an older running server would wait out every attach to `agentpane--spawn-timeout`.

The change is therefore:
- Emacs mints a per-attach token and sends it on `sessions/attach` from both `agentpane--attach` and `agentpane--attach-now`, and the helper keys its `Attaching` records by it.
- The snapshot that answers an attach carries that token in place of `askedFor`, and `agentpane--notified-buffer` binds it to the buffer whose attach sent it.
- `sessions/detach` and `sessions/close` carry the token of the buffer's attach in flight, if any, whether or not the buffer holds a handle (`agentpane-refetch` attaches a buffer that holds one), and `forget` abandons only the attach that token names; a handle alone abandons no attach.
- `introduce` answers an attach only under the handle its reply named.
- An attach abandoned while its stream's open is pending sends no REST attach (the OW-likopo amendment above).

The done condition's echo test becomes a test of the ordering in OW-savafi's body, without the echo: a snapshot under H1 for ref R arrives before the reply naming H2, and the attach binds H2 and receives its events, red first.
OW-savafi then closes `--moot` citing this card, and so does OW-jofodu.
The decision is recorded in D25 in `docs/DESIGN.md`.
