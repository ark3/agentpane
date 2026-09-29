---
labels: [question, emacs]
---

# Should agentpane-mode's helper death drop a buffer whose close was in flight, and raise turn-done at a deliberate agentpane-shutdown, where D25 reasoned only about a crash?

Filed 2026-09-28 from the adversarial read of OW-kakate, which made `agentpane--helper-gone` in `emacs/agentpane.el` leave every buffer attached through a dead helper as a `session/detached` leaves it, through `agentpane--let-go`, as D25 point 4 in `docs/DESIGN.md` decides: "a helper that crashed over a live server is rare, and costs a `g`."
Two cases fall under that rule where the helper's death is not a crash, and nobody has decided whether the rule is what the owner wants there.
Neither is a regression: the code before OW-kakate gave the same result in both.

## Case 1: a close in flight

`agentpane-close-session`'s docstring says a buffer whose close succeeded must not be left dropped, since "dropped, it would attach the session again where it should preview".
If the helper dies with `sessions/close` out, jsonrpc.el calls the close's error handler first (clearing `agentpane--closing`), then `agentpane--helper-gone` drops the buffer, so `g` sends `sessions/attach`.
Whether the close landed on the server is unknown; if it did, `g` respawns the agent the user just closed.
Measured by the reader on 2026-09-28 in batch Emacs 31.1: `handle=nil attached=nil dropped=t`, and `g` sent `sessions/attach`.

## Case 2: a deliberate shutdown

`M-x agentpane-shutdown` over a live server, with a turn streaming in a buffer no window shows, now raises the turn-done indicator ("Turn finished in …") through `agentpane--let-go` folding the not-streaming status into the watch (`agentpane--watch-turn`), although the turn goes on running on the server.
Read, not run.
Once OW-mepufi makes the helper exit when its stream drops, most helper deaths follow a server exit and the indicator is right; this case is the one where Emacs itself chose to stop listening.

## Done when

The owner's decision on each case is recorded where the next reader will look: amended into D25 point 4 in `docs/DESIGN.md`, and, where it keeps the current behaviour, in the docstring of `agentpane-close-session` (case 1) or `agentpane-shutdown` (case 2).
A decision to change either behaviour becomes a `change` card, labelled `emacs`, filed when this one closes.

## Amended 2026-09-28 under D25's follow-up

OW-mopuyi, filed 2026-09-28, makes the teardown own what a helper's death does to requests and buffers, and keeps today's outcome for both of this card's cases unless this card closes with a decision first; a decision recorded here after OW-mopuyi lands becomes a `change` card against the teardown it built.

## Amended 2026-09-29 under D26

OW-zavehi's decision, D26 in `docs/DESIGN.md`, point 7, retires `agentpane--dropped`, so a `g` in a buffer that is not attached previews rather than attaches (OW-vugefa).
That settles case 1: a buffer whose close was in flight when the helper died no longer respawns the closed session on `g`; it previews, and a session with nothing on disk answers `gone` and the buffer is killed.
D25 point 4 now reads "costs an attach".
Only case 2, the turn-done indicator at a deliberate `agentpane-shutdown`, is left for this card to decide.
