---
labels: [defect, emacs, sweep-0929]
blocked-by: [OW-hiliti]
---

# When the Emacs helper exits because its first stream open failed, the request that opened it is answered "The operation was aborted." instead of saying the server is unreachable

Found 2026-09-28 by OW-mepufi's adversarial read, and a regression of OW-mepufi: before it the reply carried the connection error.
In service of D25 point 4's promise, in `docs/DESIGN.md`, that with the server down "a request ... fails there, visibly" — visibly and legibly, so the user knows to start the server.

## What happens

Since OW-mepufi, `runHelper` in `src/emacs/helper.ts` exits when its event stream drops or its first open fails: `onDisconnect` cancels the stdin reader, and the teardown after the read loop aborts `inFlight`, the `AbortController` every REST call from the helper carries.
The first `sessions/list` or `sessions/attach` opens the stream before its own REST call (`openStream`, OW-nufafi), so with no server listening the stream's refusal lands first, the teardown aborts the request's fetch, and its reply is `-32603 "The operation was aborted."`.
Emacs shows `agentpane: sessions/list failed: The operation was aborted.` through `agentpane--request`'s error handler in `emacs/agentpane.el`, and jsonrpc's sentinel then replaces it in the echo area with `[jsonrpc] Server exited with status 0`.
Nothing the user sees says the server is unreachable.
The reader reproduced it by running `bun run src/emacs/main.ts` with its stdin held open and no server on the port (bun 1.4.0).
The same holds for a request in flight when an established stream drops, which is less important: the user was already attached and sees the buffers detach.

## Why the tests did not see it

`fetchFor` in `src/emacs/helper.test.ts` ignores `init.signal`, so no fake fetch is ever aborted, and the test "exits when the first open of its stream fails, and opens it no more (D25)" asserts only that `runHelper` resolves and that one open was made, never the reply the triggering request got.

## Done when

A test in `src/emacs/helper.test.ts`, red first, fails the first open of the stream with the listing's fetch honouring its abort signal (or refusing as a down server would), and asserts the error reply to `sessions/list` is not the abort and says the server could not be reached; the same for `sessions/attach` if its path differs.
How the helper gets there is the implementer's call — answering requests in flight with the stream's own failure before the teardown aborts them is one way — but whatever it is must not keep the process alive past the exit OW-mepufi measured, and `bun run check` passes.

## Amended 2026-09-29

The sweep behind OW-hiliti read this card as filed before OW-mopuyi landed: since then `agentpane--request` discards an error reply the dying helper writes and fails the request as the death, so a helper-side fix here would still never reach the echo area.
This card is now blocked by OW-hiliti and, once that lands, is only its `src/emacs/helper.ts` half: answer the request that opened the helper with the server being unreachable, rather than aborting it.
Re-read what Emacs shows before starting; the account above of "The operation was aborted." in the echo area may no longer hold.

## Amended 2026-09-29 under D26

OW-likopo makes the helper wait for its stream's `onOpen` before its first REST call (D26 point 4 in `docs/DESIGN.md`), so with no server listening the request that opened the helper sends no fetch at all, and the abort this card describes has nothing to abort.
What the request is answered with when the first open fails is still this card's question; re-read the path once OW-likopo lands.

## Amended 2026-09-29 as OW-hiliti landed

OW-hiliti made two changes that bear on this card.
First, `respond` in `src/emacs/helper.ts` now writes no reply for a request the helper's own teardown aborted (`inFlight.signal.aborted`), so a request whose fetch the teardown aborts is answered in Emacs by the death, "agentpane: METHOD failed: the helper exited", and never with "The operation was aborted."
Second, `agentpane--request` in `emacs/agentpane.el` now shows the message of any error reply the helper writes before it dies, and runs UNSENT only for an HTTP refusal, one whose `data` carries `status`.
So an error reply that says the server could not be reached now does reach the echo area.
Whatever shape it takes, decide whether it should carry a `status`: without one, a prompt keeps its watch, as for any outcome not known.
The helper-level tests to extend are the two "writes no reply for it (OW-hiliti)" cases under "shutdown" in `src/emacs/helper.test.ts`.

## Amended 2026-09-29 at execution

Checked against the source after OW-likopo and OW-hiliti both closed.
`openStream` in `src/emacs/helper.ts` now returns a promise that settles only on `onOpen`, and `sessions/list` and `sessions/attach` await it before their REST call; a first open that fails calls `onDisconnect`, which ends the read loop, and the promise never settles.
So with no server listening the request that opened the helper sends no fetch, its handler never settles, `respond` writes nothing, and Emacs answers it as the death: "agentpane: sessions/list failed: the helper exited" (the `requests-out` entry in `agentpane--request`, `emacs/agentpane.el`).
The abort this card was filed about is gone; the defect it names is not, since nothing the user sees still says the server could not be reached.

The done-condition, restated against that path: a test in `src/emacs/helper.test.ts`, red first, fails the first open (the fake `openEvents` calls `onDisconnect` without `onOpen`) and asserts that `sessions/list`, and separately `sessions/attach`, get an error reply whose message says the server could not be reached, written before `runHelper` resolves; the helper still exits as OW-mepufi and OW-hiliti measured, and `bun run check` passes.
The stale mentions of the fetch being aborted in the comments this path touches go with it.

The `status` question is decided: the reply carries no `status`.
In `agentpane--request`, `data.status` means the server's HTTP refusal, and no server answered here; and no caller of `sessions/list` or `sessions/attach` passes UNSENT (`agentpane--attach`, `agentpane--attach-now`, and the picker's refetch), so a `status` would change nothing today and would plant a field that lies.
