---
labels: [defect, emacs]
blocked-by: [OW-kakate, OW-mepufi]
closed: done
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

## Re-read 2026-09-28, with OW-kakate and OW-mepufi closed

Cases 2 and 3 are gone: `stream/changed` and `agentpane--stream-down` no longer exist anywhere in `emacs/` or `src/emacs/` (the retirement is recorded in the version history at the top of `src/emacs/protocol.ts`), so the ownership change's stream-down reset goes with them.
`agentpane--helper-gone` now leaves each buffer attached through the dead connection by `agentpane--let-go`, which reads the buffer idle, forgets its turn-done watch and drops its handle; that per-buffer `agentpane--let-go` is the teardown the ownership change moves, and OW-mirifa has closed, so nothing else extends it.
Cases 1, 4 and 5 stand as read against that code: `agentpane--attached-as` still sets `agentpane--attached` from the global, `agentpane--helper-gone` still skips a buffer whose `agentpane--attached` is no longer the dead connection, `agentpane--on-notification` still ignores its connection argument, and `agentpane--request`'s success handler still compares only ids.
This section supersedes the done-condition above: an ERT test for each of cases 1, 4 and 5 (both halves of 5: the late `session/status` and a late reply whose id matches `agentpane--latest-request` on the replacement) goes red before the change and green after; the `eq` guard is gone as stated; the two named tests still pass; and the suite passes.

## Amended 2026-09-28 from the adversarial read of the first cut

The first cut (branch `card/OW-bukupu`, three commits) moved the teardown into `agentpane--connection` and added a filter in `agentpane--on-notification` and in `agentpane--request`'s success handler that drops whatever is delivered through a connection that is no longer current.
The reader reproduced all four cases going red before and green after, and found these against the filters; each is part of this card's done-condition:

- The filters decide by when jsonrpc.el delivers a message, not by when the dead helper wrote it, so the last `session/node` or `session/error` a helper wrote before exiting is dropped whenever its sentinel runs first, which undoes OW-mepufi's flush of the throttled node before exit ("fix(emacs): send a node the throttle holds before the helper exits at a drop").
  Reproduced with the helper writing a node and exiting while Emacs is busy: nothing drawn; `main` draws it, but only by re-binding the let-go buffer to the dead handle, which is case 5.
  A test must show such a final node drawn and the buffer still let go afterwards.
- `:error-fn` is the failure path itself and never consults the `answered` flag, so an error reply the dead helper wrote before exiting fails the request a second time after the sentinel failed it; the docstring's "fails once" is false there.
  A test must show one failure.
- A success reply through a torn-down helper runs UNSENT, which says the request reached no backend, though the reply proves it did: a prompt the server accepted keeps its draft.
- A chain begun from the dead helper's reply while it is still current but dead -- an attach answered, then `agentpane--attached-then` running the prompt -- arms the turn-done watch, then `agentpane--request`'s `agentpane--connection` runs the teardown inside that call, forgetting the watch and dropping the buffer, and the prompt still goes out through the replacement.
  Not a regression (`main` ends in the same state), but a case the teardown's ownership misses.

## Amended 2026-09-28 from the adversarial read of the second cut

The second cut deferred the sentinel's teardown behind the helper's queued messages, kept the synchronous teardown in `agentpane--connection` for a replacement started in the gap, and added a table of in-flight requests that teardown fails.
Its reader reproduced, with probes whose ordering is driven by real processes:

- An attach that the helper answered after writing a `session/snapshot` and then exiting is failed by the new check in `agentpane--attach`, so the buffer never becomes attached and the teardown's `eq` test on `agentpane--attached` skips it: it keeps the dead helper's handle and reads streaming, and `g` previews rather than re-attaches.
  The same end state follows, on `main` too, when the helper writes the snapshot and dies before it replies.
- A request sent from the handling of the dead helper's own queued messages, such as the picker refetch a `sessions/changed` runs, tears the helper down synchronously mid-drain, and the notification filter then drops the node it flushed after that `sessions/changed` (OW-mepufi).
- The `jsonrpc-running-p` check on the attach reply is a check at the site: a helper dying between it and the chained prompt's `agentpane--connection` still sends the prompt through the replacement.
- A prompt reply held as a jsonrpc.el "anxious continuation" behind an outstanding synchronous request is re-queued after the teardown, so the prompt fails though the backend admitted it; `main` ran both its callback and its failure.

What the first three share is `agentpane--connection` replacing a connection that has exited but not yet been torn down.
So the ownership this card asks for now reads: a helper starts only once the previous one's teardown has run, the teardown being the one thing that retires a connection.
And the teardown lets go of every buffer the dead helper gave a handle, attached or not.
The done-condition gains a test for each of the first three, red before and green after; the fourth is either fixed with a test or recorded as the design's accepted cost where the next reader will find it.

## Close note

Landed on main 2026-09-28 in three commits after three implementer cuts and three adversarial reads.
The ownership change: `agentpane--connection` in `emacs/agentpane.el` starts a helper only when none is set, and refuses with "The agentpane helper has exited" while an exited one awaits its teardown, so no replacement ever stands beside a dead connection; the teardown, `agentpane--helper-gone`, is the only thing that clears it, and the sentinel's `:on-shutdown`, `agentpane--helper-exited`, defers it by a zero-delay timer behind the messages the helper wrote last, so its final node (OW-mepufi) and last status reach the buffer before it is let go.
The OW-toyupa `eq` guard is gone.
The teardown also lets go of every buffer the dead helper gave a handle through a notification, recorded in the buffer-local `agentpane--served-by`, attached or not, which also settles OW-zedawo's case 1.
`agentpane--request` answers each request once, the sentinel's "Server died" deferred behind the helper's queued replies, so a late error reply fails once and an admitted prompt clears its draft.
Rejected on the way: filtering messages from a non-current connection by delivery time (dropped the helper's last node), and a synchronous teardown in the gap with a table of in-flight requests (reentrancy, and three regressions the second read reproduced).
Verified: 13 new ERT tests in `emacs/agentpane-test.el`, 12 red on main's `agentpane.el` as run by the third reader (`agentpane-test-held-back-reply-answers-once` guards the accepted cost and passes on main); the full suite at 208 tests, 205 expected, 3 skipped, green on main after the cherry-pick; `agentpane-test-turn-done-watch-ends-with-the-helper` still passes and `agentpane-test-late-sentinel-keeps-the-replacement-helper` became `agentpane-test-no-replacement-before-the-teardown`.
Filed from the third read: OW-laluso (sentinel walk cut short by a synchronous request's throw leaves older requests unanswered, pre-existing), OW-kifuhi (held-back attach reply after the teardown, the design's accepted cost), OW-kimafi (refusal noise in timer handlers); OW-zedawo amended, its case 2 standing.
