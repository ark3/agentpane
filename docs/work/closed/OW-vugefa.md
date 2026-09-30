---
labels: [change, emacs, sweep-0929]
blocked-by: [OW-royosa, OW-likopo, OW-bupivi]
closed: done
---

# agentpane-mode keeps agentpane--dropped so g re-attaches a buffer its helper let go, and asks a listing after a close; under D26 a buffer not attached previews, and a preview answered gone kills it

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`, point 7.
It is the Emacs half of what OW-lilami does in the browser, and waits on OW-royosa for the preview's `gone`, OW-likopo for the helper's `ended`, and OW-bupivi for the attach-only command that becomes the explicit way to go live.
It absorbs OW-vetebu and the remaining edge of OW-wabiju, both closed `--moot` into it on 2026-09-29; read them with `card show`.

## What is there now

`agentpane--dropped` in `emacs/agentpane.el` is set by `agentpane--let-go`, cleared by `agentpane--attach-by`, `agentpane-close-session` and, for a Pi parent once its fork lands, `agentpane--fork-at`, and read in one place: `agentpane-refetch`'s `(or agentpane--attached agentpane--dropped)`, which makes `g` attach rather than preview in a buffer the helper let go of, so as not to draw the stored transcript over the live one.
`agentpane-close-session`, once `sessions/close` answers, asks `sessions/list` to choose between redrawing from the stored transcript and killing the buffer for having nothing on disk (OW-vasubu), putting the composer's text on the kill ring first; when that listing fails the buffer stays, holding no handle (OW-vetebu).
`agentpane--request` hands its caller no error: FAILED and UNSENT run with no arguments and the error goes only to the echo area, and the test macros that fail a held request, `agentpane-test--forking` among them, fail it with `nil`, so today nothing can tell a `gone` from any other failure.
`agentpane-refetch` refuses while `agentpane--closing` is set, and today the close's listing callback clears that flag before it calls `agentpane-refetch`.
About fifteen assertions in `emacs/agentpane-test.el` read `agentpane--dropped`, and `agentpane-test-close-session-listing-that-fails-frees-the-buffer` asserts that `g` previews after a failed listing.

## What to build

- `agentpane--dropped` goes: a buffer is live exactly when `agentpane--attached`, and `g` in one that is not sends `sessions/preview`.
- `agentpane--request` gives a caller the error's `data`, or a failure path keyed on its `error`, so a preview's caller can tell `gone`; the test macros that fail a held request can fail it with that data.
- A `sessions/preview` answered with an error whose `data` carries `error: "gone"` kills the buffer as `agentpane-close-session` does today for a session with nothing on disk, composer text to the kill ring first, from every path that previews: `g`, the preview after a close, and a picker row.
  Any other failure leaves the buffer as it is and says so in the echo area.
- `agentpane-close-session` asks no listing: once the close answers it clears `agentpane--closing` and previews, and `gone` kills.
- A first cut, flagged in D26 point 7: a buffer holding a name that no longer reaches its session (D21's "Still open") is killed at its next `g`, where it used to retry an attach that answered 404; OW-tujami carries whether it can learn the new name instead.

## Records that change with it

The docstrings of `agentpane--let-go`, `agentpane-refetch`, `agentpane-close-session` (its passage beginning "Nor is it dropped") and `agentpane--request`, and the code in `agentpane--attach-by` and `agentpane--fork-at` that clears the flag.
`docs/DESIGN.md` D25 point 4 already reads "costs an attach"; check nothing else there still names `g` as the way back -- the D21 reconnect paragraph (the one containing "which comes back by its ref on `g` or its next prompt") still does.

## Done when

ERT tests in `emacs/agentpane-test.el`, red first:
- a buffer the helper let go of by `session/detached` sends `sessions/preview` on `g`, not `sessions/attach`;
- a Pi fork's parent that receives `session/detached` while its fork is in flight previews on `g` after the fork lands (OW-wabiju's edge);
- a preview answered `gone` kills the buffer and leaves the composer's text at the head of the kill ring; one answered any other error does not kill it;
- `agentpane-close-session` sends no `sessions/list`, and a close whose preview answers `gone` kills the buffer (OW-vetebu's case), built on the `agentpane-test--closing` macro.
`agentpane--dropped` is gone from `emacs/agentpane.el` and its tests.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Built in `emacs/agentpane.el`: `agentpane--dropped` is gone, so a buffer is live exactly when `agentpane--attached`, and `g` (`agentpane-refetch`) in any other buffer sends `sessions/preview`; going live is a send or `a` (`agentpane-attach`, OW-bupivi).
`agentpane--request` gained a last optional argument, ERRED, run after FAILED with the helper's error `data` (`{status, error, detail}`, `toRpcError` in `src/emacs/helper.ts`), gated as CALLBACK is on the buffer being live and the request still the latest; a timeout, the helper's death and a non-local exit run none.
A preview answered `error: "gone"` calls the new `agentpane--gone`, which puts the prompt region's text and an open edit's draft on the kill ring and kills the buffer; `g`, the preview after a close and a picker row (`agentpane-show-transcript`) all go through `agentpane-refetch`.
Any other preview failure leaves the buffer.
`agentpane-close-session` asks no `sessions/list`: once the close answers it clears `agentpane--closing` and previews.
Docstrings of `agentpane--request`, `agentpane--let-go`, `agentpane-refetch`, `agentpane-close-session`, `agentpane--closing`, `agentpane--helper-gone`, `agentpane-fork` and `agentpane--attached` updated, and `docs/DESIGN.md` D21's four sentences naming `g` as the way back now name a send or `a`; D26 point 7 records it built.

Verified: new and rewritten ERT tests in `emacs/agentpane-test.el` (`agentpane-test-detached-lets-go-of-the-handle-and-g-previews`, `agentpane-test-pi-fork-parent-detached-before-the-reply-previews`, `agentpane-test-preview-gone-kills-the-buffer-keeping-its-text`, `agentpane-test-preview-gone-kills-only-as-the-latest-request`, and the `agentpane-test-close-session-*` set on `agentpane-test--closing`, including `...-whose-preview-is-gone-kills-the-buffer` for OW-vetebu's case) each seen red against the base; an adversarial reader's mutations (dropping the latest-request gate, ignoring `gone`, dropping the `kill-new`) each turned tests red.
ERT: 220 run, 0 unexpected, 3 skipped; `bun run check`: 54 files, 1556 tests pass.

Accepted behaviour change: a send while the post-close preview is out now goes out and supersedes it, where the old listing kept the close in flight (OW-watawe); for a session with nothing on disk that send's attach fails, the text stays in the prompt region, and the next `g` kills the buffer with the text on the kill ring.
The test macro `agentpane-test--forking` runs ERRED and CALLBACK without modelling supersession, as it did CALLBACK before; supersession is pinned only through the real `agentpane--request` in `...-kills-only-as-the-latest-request`.
Filed OW-luwita for a preview superseded by no request when `agentpane--attach-now` attaches synchronously; amended OW-sihoma, since `g` and a picker row now also strand a composer buffer.
