---
labels: [change, emacs, sweep-0929]
blocked-by: [OW-sodohi]
closed: done
---

# The Emacs helper learns a handle ended from a listing and sends an attach before its stream is registered, where D26 has it act on the ended event and wait for the open

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`, points 2 and 4.
OW-sodohi makes the server send `ended` where it forgets a handle; this card makes `runHelper` in `src/emacs/helper.ts` act on it and removes the listing inference it replaces.
The Emacs wire needs no new message: `session/detached { session, handle }` in `src/emacs/protocol.ts` already says a handle is gone, though that file's docblock names the listing as its cause and changes with this card.

## What to build

- On `ended`, send `session/detached` for an attachment under that handle, and release a held attach waiting on a snapshot under it (the `Attaching` records, whose reply waits for its snapshot since OW-rebawa).
  A held attach has no view in the reducer yet, so this is handled before the early return `onEvent` takes when the reducer's state is unchanged.
- `dropDead`'s eviction goes: the listing it asks at every `sessions-changed` no longer drops an attachment or a held attach.
  The `sessions/changed` notification to Emacs stays, since the picker and `agentpane--note-turns` in `emacs/agentpane.el` read listings of their own.
- A request that opens the stream -- `sessions/list` and `sessions/attach`; preview, create and the model listing do not -- waits for its open before its own REST call.
  `openStream` starts the stream with `onOpen() {}` and `sessions/attach` and `sessions/list` send their request straight after, but the events GET and the attach GET are separate connections, so an attach's snapshot and a close's `ended` can both be broadcast before `openEventStream`'s `start()` in `src/server/http/app.ts` registers the helper, leaving the attach held with nothing to release it until `agentpane--spawn-timeout`.
  `onOpen` fires once the response headers arrive (`sseOpenEvents` in `src/emacs/sse.ts`), and `openEventStream` registers the client in its stream's `start()`, which runs as the response is built; confirm that ordering at the source before relying on it.
  A first open that fails still ends the helper as D25 point 4 decides, and the requests waiting on it are answered by agentpane-mode's teardown at the helper's death (`agentpane--helper-gone`); OW-pezelo's account of which of the open's refusal and the request's fetch lands first changes with this, and that card is amended to say so.

## Records that change with it

In `src/emacs/protocol.ts`, the entries for `session/detached` ("the helper's own listing … having lacked it"), `sessions/changed` ("Any `session/detached` the helper's own listing brings follows it") and `sessions/attach` ("the session's handle left the listing before its snapshot came", and "Opens the event stream if it is not open yet").
The head of `src/emacs/helper.ts`, `detachGapped`'s docblock ("as for a handle the server let go (`dropDead`)"), the attach handler's comment "It is entered before the REST call, not only once the stream has opened", and its comments on `dropDead`, on an attach's held reply ("a listing without the handle" is one of what releases it), and on `onMalformed`, which says a malformed frame "costs at most a seq gap, which the next event detaches" and is false for `ended`, which no later event follows (D26 point 4 corrects the comment rather than guarding it).
D21's paragraphs on the helper dropping attachments a listing lacks are already marked by D26 as retired; check they read as history once this lands.

## Done when

Tests in `src/emacs/helper.test.ts`, red first, with the fake event source and `fetch` the file's other tests use; the fake source fires `onOpen` by itself a microtask after the open, so the third test needs it to hold the open until released, a knob the fake gains:
- an attachment receives `ended` while the listing its `sessions-changed` asks fails, and Emacs gets `session/detached` under the handle;
- an attach whose reply waits on a snapshot is released by an `ended` under the reply's handle, and its reply goes out;
- the first `sessions/attach` sends no REST request until the stream's `onOpen` has fired;
- a listing that lacks an attachment's handle, with no `ended`, sends no `session/detached`.
`dropDead`'s eviction is gone from the code.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

## Close note

Built in `src/emacs/helper.ts`: `runHelper` now acts on the server's unsequenced `ended` (`end()`), sending `session/detached` for an attachment under the handle and releasing a held attach waiting on a snapshot under it, handled before `onEvent`'s return on an unchanged reducer state.
`dropDead` is gone: a `sessions-changed` now only produces `sessions/changed`, and no listing drops an attachment or a held attach.
`sessions/list` and `sessions/attach` await a memoised `openStream()` promise that settles on `onOpen` before their REST call; a first open that fails never settles it and the helper exits as D25 point 4 says (what that request is answered with stays OW-pezelo's).
Confirmed at the source that `onOpen` implies registration: `openEventStream` in `src/server/http/app.ts` calls `addClient` in the `ReadableStream`'s `start()`, which runs synchronously before the `Response` exists.

The adversarial read found one defect this made common: a Pi fork's parent `ended` lands before the `sessions/fork` reply, so the parent buffer was left `agentpane--dropped` and `g` re-attached it, respawning Pi on the old branch.
`agentpane--fork-at`'s Pi branch in `emacs/agentpane.el` now clears `agentpane--dropped` as `agentpane-close-session` does, with ERT test `agentpane-test-pi-fork-parent-detached-before-the-reply-previews`.
Its other non-regression finding, an attach abandoned by a detach while the open is pending still sends its REST attach, went into OW-wukako as an amendment.

Records updated: `src/emacs/protocol.ts` (frozen-interface history, `sessions/list`, `sessions/attach`, `session/detached`, `sessions/changed`), the helper's docblocks and `onMalformed` comment (corrected, not guarded), docstrings in `emacs/agentpane.el` and `emacs/agentpane-test.el`, and D21's and D25's helper-listing paragraphs in `docs/DESIGN.md`, now history.

Verified: four new or rewritten tests in `src/emacs/helper.test.ts` (ended detaches while a listing would fail; ended releases a held attach; first attach and a concurrent list send nothing until `onOpen`, via the fake source's new `holding`/`openHeld()`; a listing lacking the handle with no `ended` detaches nothing) fail against the pre-change `helper.ts` and pass after; the new ERT test failed first on `agentpane--dropped` being `t`.
`bun run check` passed (1517 tests) and the ERT suite passed (217 run, 0 unexpected, 3 skipped).
