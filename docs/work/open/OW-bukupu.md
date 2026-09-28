---
labels: [defect, emacs]
blocked-by: [OW-kakate, OW-mepufi]
---

# agentpane-mode lets a dead helper's late sentinel and its late-delivered messages act on the helper that replaced it; teardown and message dispatch should be owned per connection, retiring OW-toyupa's eq guard

Filed 2026-09-28 from the adversarial read of OW-toyupa, the sibling D24 and the rule in `AGENTS.md` ("The sibling rule") call for: OW-toyupa closed with a guard at the site, and its reader named cases the guard misses.
One card carries all of them, since they share one cause and one fix.

## The cause

`agentpane--connection` in `emacs/agentpane.el` replaces the helper connection whenever the global `agentpane--connection` is not `jsonrpc-running-p`, and every handler treats that global as "the connection this came from".
Two things in jsonrpc.el on Emacs 31.1 (`/usr/share/emacs/31.1/lisp/jsonrpc.el.gz`) break that assumption once a helper dies:

- A dead child reads as not `process-live-p` before its sentinel runs; the sentinel runs only when Emacs next waits (measured by OW-toyupa's implementer on 2026-09-28; the recipe is in the OW-toyupa commit message, "fix(emacs): forget a dead helper's connection on its shutdown only while it is still the current one").
- `jsonrpc--process-filter` delivers each parsed message through a zero-delay timer, so a message the dead helper wrote before exiting can be handled after its sentinel, and `jsonrpc--process-sentinel` calls every pending request's error handler without clearing `jsonrpc--continuations`, so a reply read after that still runs its success handler.

OW-toyupa's fix is `(when (eq agentpane--connection connection) (setq agentpane--connection nil))` in `agentpane--helper-gone`; that guard is what this card retires.

## Cases the guard misses

All but the last were measured by the reader in batch Emacs 31.1 against small fake helpers, with nothing in the repo changed; treat them as findings to reproduce, not as settled.

1. A late attach reply binds a buffer to a helper that attached nothing.
   Buffer B sends `sessions/attach` on helper D; D writes the reply and dies while Emacs is busy; a command in the gap starts replacement R; D's sentinel errors B's attach and `agentpane--helper-gone` skips B, not yet attached; then D's reply is delivered and `agentpane--attached-as` calls `(agentpane--hold-attached agentpane--connection)`, which is R.
   Measured with the guard: B reads attached to R under handle `h1`; without it, B read not attached.
   R's helper holds no attachment for that handle, so by reading `isAttached` in `src/emacs/helper.ts` drops that session's notifications and B's turn-done watch never ends.
2. D's own last `stream/changed` `reconnecting`, delivered after its sentinel, sets `agentpane--stream-down` after `agentpane--helper-gone` cleared it, and the next helper inherits "reconnecting" in every mode line (`agentpane--show-mode-line`), because `openStream` in `src/emacs/helper.ts` starts `down` false and sends `connected` only on a transition.
   Measured with and without the guard; needs no replacement in the gap.
3. R's own `reconnecting`, handled before D's late sentinel, is erased by the unconditional `(agentpane--hold-stream-down nil)` in `agentpane--helper-gone`, and R never repeats it.
   Measured: ready output from R was handled before D's sentinel in 5 of 5 raw-process runs.
4. A buffer that R re-attached before D's sentinel ran is skipped by `agentpane--helper-gone`'s `eq` test on `agentpane--attached`, so its turn-done watch is not forgotten, which brings back what OW-dunahe fixed (`agentpane-test-turn-done-watch-ends-with-the-helper`).
   Same ordering as 3; from reading plus that probe.
5. By reading only: D's late `session/status` with `isStreaming` true, delivered after `agentpane--helper-gone` ran `agentpane--read-idle`, leaves the buffer reading streaming; and request ids count per connection, so a late D reply could match `agentpane--latest-request` on R.

## The ownership change

What is load-bearing is that nothing from a connection that is no longer current touches current state; the shape below is the reader's proposal, and the implementer may choose another that covers the same cases.

- `agentpane--connection`, when it replaces a connection that is set but not running, does that connection's teardown itself before creating the new one (the per-buffer watch-forget and `agentpane--read-idle` `agentpane--helper-gone` does today), and resets `agentpane--stream-down` where the new connection is created, matching `let down = false` in `openStream`.
- `agentpane--helper-gone` acts only when its connection is still current; otherwise the teardown has already run.
- `agentpane--on-notification` drops a notification whose connection argument, received today and ignored, is not the current connection.
- A reply from a connection that is no longer current is dropped, or `agentpane--attached-as` takes the connection the reply came on rather than the global; `agentpane--request` is where the connection is known.

OW-mirifa ("agentpane-refetch previews rather than re-attaches a buffer whose helper died") also extends the teardown `agentpane--helper-gone` does; whichever lands second puts its marking wherever the teardown then lives.
The reader also suggested, unverified, that timers run before sentinels in each wait, so D's own earlier `sessions/changed` could start R inside the gap and make it common rather than rare; measuring that is optional here.

## Done when

- An ERT test in `emacs/agentpane-test.el` for each of cases 1 through 4 goes red before the change and green after; delivering a message on a dead connection can go through a fake helper that writes and exits while Emacs does not yield, as the reader did, or through `jsonrpc-connection-receive` called on the dead connection after its shutdown, whichever drives the order deterministically.
- The `eq` guard OW-toyupa added in `agentpane--helper-gone` is gone, replaced by the ownership change rather than kept beside it, and `agentpane-test-late-sentinel-keeps-the-replacement-helper` and `agentpane-test-turn-done-watch-ends-with-the-helper` still pass.
- The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Amended 2026-09-28 under D25

Under D25 the helper exits when its stream drops and never sends `stream/changed` (OW-mepufi), so cases 2 and 3 above, a late or early `reconnecting`, disappear with `agentpane--stream-down`.
And a helper's death leaves every buffer as a `session/detached` does (OW-kakate), which changes what `agentpane--helper-gone` does and so what case 4 reads.
Cases 1, 4 and 5 stand, since Emacs still starts a replacement lazily through `agentpane--connection`, and helper deaths become the normal path whenever the server goes away.
Blocked by OW-kakate and OW-mepufi so that this card is written against what they leave; re-read the cases then, and drop any they settled.
