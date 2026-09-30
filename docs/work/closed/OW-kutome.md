---
labels: [defect, emacs, sweep-0929]
closed: done
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

## Close note

Built: `session/detached` carries `cause: "ended" | "gapped"` (`src/emacs/protocol.ts`, the thirteenth raise of the frozen interface), which `end` and `detachGapped` fill in `src/emacs/helper.ts`.
`agentpane--let-go` in `emacs/agentpane.el` takes `&optional gapped`, and at a gap it ends the turn-done watch before the buffer reads idle, so a turn the gap stops this Emacs hearing raises nothing, as the browser raises no favicon.
The server's `ended` and a helper's death keep the old order, so they still raise the indicator for a turn seen streaming.
OW-reyayi is still open, so `agentpane-shutdown` is unchanged and still raises, and no shutdown cause was plumbed.

Verified:
- `agentpane-test-turn-done-not-raised-by-a-gap` fails against the code from before this card and passes after.
- `agentpane-test-turn-done-raised-when-the-server-lets-go` pins the unchanged `ended` path; it was seen red by forcing forget-first for every cause.
- Both `session/detached` assertions in `src/emacs/helper.test.ts` now pin `cause` and went red first.
- `bun run check` passed: 1558 tests.
- ERT: 226 run, 223 passed, 3 skipped.

The adversarial read found that the fix is an ordering flag at the site.
It misses a re-attach under the same live handle, where the browser's watch survives the gap and raises at the turn's end, and a gap revealed by the turn's own final status; both are filed as OW-homogu.
Its doc findings (a gap *may* leave a turn running, and helper-gone's comparison names the `ended` kind) and the two OW-tifiva tests that now send `cause "gapped"` landed with the change.
OW-puzome closed moot against this card, and OW-reyayi was amended: case 2 has a mechanism, and only the decision remains.
