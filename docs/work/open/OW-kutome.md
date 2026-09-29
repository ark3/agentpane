---
labels: [defect, emacs, sweep-0929]
---

# agentpane--let-go reads every way of losing a handle as the turn ending, so a sequence gap or a deliberate agentpane-shutdown raises turn-done for a turn that goes on

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).
It is meant to supersede OW-puzome and to give case 2 of OW-reyayi its mechanism; the decision in OW-reyayi's case 2 stays the owner's.

`agentpane--let-go` in `emacs/agentpane.el` runs `agentpane--read-idle` first and `agentpane--watch-forget` after, so the turn-done watch is folded an idle status before it ends; its docstring says so ("The turn-done watch on that handle is folded that status, then ends with the handle").
Its three callers are three different causes: a `session/detached` the server sent because it let go of the session, the same notification sent for a `seq` gap (D25 decision 5), and `agentpane--helper-gone`, which covers a crash over a live server and a deliberate `agentpane-shutdown` alike.
Only the first means the turn is over.
The browser raises nothing for a gap (OW-puzome's comparison).

## The change

`agentpane--let-go` takes its cause.
Where the turn is not known to be over, it forgets the watch before reading idle, as the deliberate detach path already does.
`session/detached` carries its cause in `src/emacs/protocol.ts`, and the helper in `src/emacs/helper.ts` fills it at each site that notifies it; `agentpane-shutdown` knows it is its own cause.
What a deliberate shutdown should raise is OW-reyayi's question; if that card is still open, implement the gap case and leave shutdown behaving as today, saying so in the close note.

## Done when

ERT tests in `emacs/agentpane-test.el`, red first: a `session/detached` for a gap mid-turn raises no turn-done indicator; one for a server let-go after a turn seen streaming still raises it, as today.
A test in `src/emacs/helper.test.ts` that the gap's notification carries the gap cause.
Then OW-puzome closes `--moot` citing this card, and OW-reyayi is amended to say its case 2 now has a mechanism and only the decision remains.
