---
labels: [change, emacs, d25]
---

# An agentpane-mode buffer is bound to a handle both by its attach reply and by the helper's snapshot, so a reply that lands late rebinds a buffer the helper no longer feeds; only the helper's notifications should say a buffer is attached

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, section "What the run found, and the two ownership changes it asked for", which the owner took that day; read it first.
OW-tifiva and OW-kifuhi closed moot into this card; each names orderings its tests must cover, and both are worth reading for the reproductions.

## What happens

Whether a buffer is attached is decided on two channels.
The helper's notifications bind it: a `session/snapshot` under a handle reaches the buffer that asked through `agentpane--notified-buffer` in `emacs/agentpane.el`, by the handle or by the `askedFor` D24 added (OW-mofuho), and `agentpane--on-notification` records the connection that fed it in `agentpane--served-by` (OW-bukupu).
The attach reply binds it too: `agentpane--attached-as` sets `agentpane--attached`, takes the reply's handle and clears `agentpane--dropped`, from both `agentpane--attach` and `agentpane--attach-now`.
The helper keeps a third record, its `attached` map in `src/emacs/helper.ts`, of what it forwards, which its `sessions/attach` handler fills at the reply even when it holds no view to forward.
When the channels disagree, the buffer believes it is attached while the helper sends it nothing:

- OW-tifiva: a sequence gap detaches the session between the attach's snapshot and its reply, and the reply then rebinds the buffer (and, for a renamed ref, the helper records an attachment with no view and sends nothing).
- OW-kifuhi: jsonrpc.el holds an attach reply behind a synchronous request as an "anxious continuation" (`docs/MANUAL_TESTING.md`, "jsonrpc.el runs an async reply after later notifications"), the helper dies meanwhile, and the reply later binds the buffer to nothing, or to the next helper.
- OW-wabiju's second edge, a `session/detached` that lands ahead of a parked attach reply, is the same shape and is amended to point here.

The synchronous requests are not the defect: `agentpane--attach-now`, `sessions/create` in `agentpane-new-session`, and the `models/list` reads in `agentpane--read-model` and `agentpane--read-effort` each need an answer before the minibuffer can prompt, and they stay.

## The change

A buffer is attached exactly when the helper has sent it a snapshot under a handle and has not since sent `session/detached` for that handle or died.
The attach reply ends the request and nothing more: it clears `agentpane--attaching` and reports a failure, and it never binds a handle, sets `agentpane--attached`, or clears `agentpane--dropped`.
In the helper, an attachment is recorded when it forwards the snapshot that introduces it, not at the reply; a reply with no snapshot to forward leaves nothing recorded.
An attach whose snapshot never reaches the buffer therefore ends not attached, and `g` attaches again, D25's one-click cost.
Where `agentpane--attached`, `agentpane--served-by` and `agentpane--attach-sent` can then collapse into one record is this card's call; D25 names one owner, and the commit says which of the three survive and why.
The merge `agentpane--attached-as` performs when a reply names a handle another buffer already holds (`agentpane--absorb`) moves to wherever the snapshot binds, and keeps its tests.
`agentpane--notified-buffer`'s docstring and `agentpane--request`'s paragraph naming OW-kifuhi as an accepted cost are brought in line.

## Done when

Tests, each red first on the code as it stands:

- In `src/emacs/helper.test.ts`, OW-tifiva's two orderings, driven with the fake event source and `fetch` the file's other tests use: the helper records no attachment it did not forward a snapshot for, and the reply in ordering 2 reaches Emacs after its `session/detached`.
- In `emacs/agentpane-test.el`, OW-tifiva's ordering 2 as Emacs sees it, `session/snapshot`, `session/detached`, then the reply, in wire order and with the reply held as an anxious continuation: the buffer ends dropped and not attached.
- In `emacs/agentpane-test.el`, OW-kifuhi's two outcomes, an attach reply held behind a synchronous request as a real helper process dies, one reply and two: each buffer ends not attached, holding no handle, dropped, and no prompt is sent through a later helper.

The existing merge tests pass unchanged or are named in the commit where they moved.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
