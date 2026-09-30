---
labels: [change, emacs, sweep-0929]
closed: done
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

## Close note

Built 2026-09-30 in 0da9e24, with review fixes in 5d1d3cb.
Decision: no server echo. The attach's REST reply already names the handle the attach landed on, so dropping `introduce`'s early answer by ref settled OW-savafi with no wire field; the echo alone would have told the gap misjudgment D25 admits apart from a lost-frame gap, at the cost of a list-valued field on the HTTP snapshot (concurrent attaches collapse onto one startup in `SessionManager.attach`) and a helper/server skew hazard. Recorded in D25, docs/DESIGN.md, "The helper matched an attach to its answering snapshot".
What changed: agentpane-mode mints a per-attach integer token (`agentpane--attach-token`, held in `agentpane--attach-sent`) and sends it on sessions/attach from `agentpane--attach` and `agentpane--attach-now`, and on sessions/detach and sessions/close whether or not the buffer holds a handle. The helper keys `Attaching` by it, tags the answering snapshot with `token` in place of `askedFor`, `forget` gives up only the attach its token names, `introduce` answers an attach only under its reply's handle, and an attach given up while the stream's open is pending sends no REST attach and answers a -32603 with no data.status. `agentpane--notified-buffer` binds a tagged snapshot to the buffer whose `agentpane--attach-sent` is that token. src/emacs/protocol.ts raised a fourteenth time.
Verified: seven vitest cases in src/emacs/helper.test.ts under "the attach token (OW-wukako)" (two-buffer detach by handle with and without the killer's token, a mid-attach kill by token, a close racing a re-attach, OW-savafi's ordering with H2's snapshot before and after the reply, an attach given up during the open), all red against the old helper as re-run by the adversarial reader; ERT `agentpane-test-kill-of-a-buffer-holding-the-handle-leaves-anothers-attach-of-its-ref`, red against the old agentpane.el; `bun run check` (1568 tests) and ERT (237, 234 as expected, 3 skipped) green.
The implementer added one exception past the card: a detach without a handle whose token gave up a waiting attach skips the by-ref attachment drop, tested. The adversarial read judged it a guard at the site that misses a let-go buffer's stale token, which predates this card; filed as OW-linowe to replace the by-ref drop.
OW-jofodu and OW-savafi closed --moot citing this card.
