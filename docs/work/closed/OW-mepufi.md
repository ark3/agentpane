---
labels: [change, emacs, d25]
blocked-by: [OW-kakate]
closed: done
---

# The Emacs helper reopens its event stream after a drop and tells Emacs by stream/changed, a reconnect machinery D25 retires; the helper should exit when its stream drops or its first open fails

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first.
Blocked by OW-kakate, which makes a helper's death leave every buffer detached; land that first, so that the exits this card starts causing mean the right thing when they begin.

## What happens

`openStream` in `src/emacs/helper.ts` answers a drop by reopening after `reconnectDelayMs`, sends Emacs `stream/changed` (`reconnecting`, then `connected`, OW-mareju), and on every open after the first sends `sessions/changed` and runs `dropDead` to drop attachments whose handles the listing lacks (OW-refibu, OW-yibijo).
In `emacs/agentpane.el`, `agentpane--stream-down` and `agentpane--hold-stream-down` carry that state, and every attached buffer's mode line leads with `reconnecting` while it is set.
OW-sosape, closed moot into this card, was a gap in that machinery: a first open that fails and a later one that succeeds sends no `sessions/changed`.

## The change

When the helper's event stream drops, or its first open fails, the helper exits: `runHelper` resolves and the process ends, and Emacs's sentinel runs `agentpane--helper-gone`.
Agentpane is local-only and a drop means the server went away (D25), so there is nothing to reconnect to; the next command that needs the helper starts a new one through `agentpane--connection`, and a request to a server that is still down fails there, visibly.
What goes, with its docblocks and tests: the reopen and `reconnectDelayMs`, the `opens` count and the `sessions/changed` it sends at a reopen, `dropDead`'s run at a reopen, and `stream/changed` on both sides with `agentpane--stream-down`, `agentpane--hold-stream-down` and the `reconnecting` mode line.
What stays: `dropDead`'s run on every `sessions-changed`, since another client's close while the stream is up is still a real case (D25).
A picker open when the helper exits goes stale until `g`, which the owner accepted on 2026-09-28; it shows no disconnection of its own.
The helper's module docblock and D21's paragraphs on agentpane-mode's reopen are brought in line; D25 already says D21's reopen paragraphs are superseded for this client.
`stream/changed` is also on the wire in `src/emacs/protocol.ts`: its entry in the notification list, its member of the notification union, and the FROZEN INTERFACE docblock's line that OW-mareju raised the contract a seventh time for it; retiring it raises the contract a ninth time, recorded in that docblock the way OW-filuge's eighth was.

## Done when

A test in `src/emacs/helper.test.ts`, red first, opens the stream through `sessions/list`, drops it, and asserts `runHelper` resolves and no second open was made; another fails the first open and asserts the same.
The tests of the reopen, of `stream/changed` and of the `reconnecting` mode line are removed, and named in the commit message.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Landed 2026-09-28 as two commits on main, "fix(emacs): exit the helper when its event stream drops or its first open fails, instead of reopening it (OW-mepufi)" and "fix(emacs): send a node the throttle holds before the helper exits at a drop (OW-mepufi)".

`onDisconnect` in `runHelper` (`src/emacs/helper.ts`) now flushes any held nodes, sets `stopped` and cancels the stdin reader, so the read loop ends as it would at end of input and the common teardown runs; `stopped` also keeps a request already read from opening a second stream in that window.
Measured by driving `bun run src/emacs/main.ts` with its stdin held open (bun 1.4.0): the helper exits with code 0 within about 20ms of a drop or of a failed first open, so `main.ts` needed no change.
Retired, as D25 asked: the reopen, `reconnectDelayMs`, the `opens` count and its `sessions/changed`, `dropDead`'s run at a reopen, `stream/changed` in the helper, `src/emacs/protocol.ts` (contract raised a ninth time) and `emacs/agentpane.el`, with `agentpane--stream-down`, `agentpane--hold-stream-down` and the `reconnecting` mode line.
`agentpane--hold-attached` went too, since OW-mareju added it only to redraw that field; its callers set `agentpane--attached` again.
`dropDead` on every `sessions-changed` stays.
The helper, `sse.ts` and protocol docblocks, D21's reopen paragraphs and D24's clause are brought in line.

Verified: the two new helper tests ("exits when the stream it opened for sessions/list drops...", "exits when the first open of its stream fails...") went red against the old helper with `runHelper` still pending, and the flush test ("sends a held node before it exits at a drop of the stream (D25)") red against the first commit; `bun run check` passed with 1482 tests, and the ERT suite ran 196 tests, 193 as expected, 0 unexpected, 3 skipped.
The removed tests are named in the first commit's message.

The adversarial read found no correctness defect.
It found that a first open failing with no server makes the triggering request answer "The operation was aborted." rather than the connection error, filed as OW-pezelo.
