---
labels: [defect]
blocked-by: [OW-jifibo]
closed: promoted
---

# A Pi stop waits out every unanswered prompt's preflight, so an extension command awaiting idle defeats Stop, and client timeouts outrun the waits

Filed 2026-10-15 from the adversarial read of OW-jifibo, by reading the installed `pi 1.2.0` package and agentpane's code; nothing here was measured against a live Pi.

OW-jifibo made `PiAdapter.abort` in `src/server/adapters/pi/process.ts` send `clear_queue` only once every `prompt` already written has been answered (`unansweredPrompts`), and made `PiAdapter.submit` hold a prompt sent during a stop until the stop settles (`stopping`).
That ordering is correct for what it was built for: a steer still in Pi's preflight when Stop is pressed is no longer stranded (see the `abort` docblock and D16 in `docs/DESIGN.md`, "OW-jifibo replaced that refusal").
What it costs is that both waits are now unbounded by anything but Pi, and three cases follow from that.

## 1. An extension command that waits for idle defeats Stop

As of `pi 1.2.0` (read, not measured), Pi answers a `/cmd` prompt only after `_tryExecuteExtensionCommand` has awaited the command's whole handler, and in rpc mode the command context's `waitForIdle` is `session.waitForIdle()` (`dist/modes/rpc/rpc-mode.js`, `extensions/runner.js` `createCommandContext`).
Sequence: during a turn the user sends `/cmd`, whose handler calls `ctx.waitForIdle()`, then presses Stop.
The stop waits for `/cmd`'s answer, which waits for the turn to end by itself, so `clear_queue` and `abort` go out after the turn has already finished and the Stop stops nothing.
Before OW-jifibo the `abort` went out at once.
A prompt Pi handles as an extension command never queues a steer, so the wait on it buys nothing; but the adapter cannot tell from the text alone, because `/skill:...` and prompt templates also start with `/` and do steer (the `abort` docblock, "a steered `/skill:...` comes back expanded").
Slow `input` handlers (`_runInputHandlers`) and an idle Pi's preflight compaction in `_prepareRun` delay a Stop the same way, less sharply; the docblock names those as a cost already.

## 2. A held prompt can run after its client gave up on it

`src/server/index.ts` sets Bun's `idleTimeout: 60`; the reader saw Bun 1.4.0 close a client socket whose handler outlasted a short `idleTimeout`, so a `POST` prompt held behind a slow stop for over about a minute fails at the browser as a network error and the browser keeps the draft.
The Emacs `sessions/prompt` request times out at `agentpane--spawn-timeout` (60 s) in `emacs/agentpane.el` and runs its FAILED path, keeping the draft too.
The server-side `submit` keeps waiting, and if the stop then settles the prompt goes out and starts a turn; the user, holding a draft that reads as unsent, sends it again and runs it twice.
Before OW-jifibo the same prompt was refused at once with a 500 and could not be sent twice.
A truly hung stop does not duplicate: closing the session fails the held prompt.

## 3. Emacs drops a slow stop's texts after ten seconds

`agentpane-abort` in `emacs/agentpane.el` sends `sessions/abort` through `agentpane--request` with no timeout argument, so jsonrpc's default (`jsonrpc-default-request-timeout`, 10 s) applies and a reply after it is discarded with its `:queued` texts.
A stop's latency now includes any unanswered prompt's preflight, so case 1's waits reach this; before, only Pi's own abort latency did.
The browser's stop has no client timeout of its own, only Bun's idle reap from case 2.

## What to decide and change

These are one property: the server's waits on Pi are unbounded while both clients' waits on the server are bounded, and the stop now waits on prompts as well as on Pi's abort.
Decide, and record at the `PiAdapter.abort` docblock and in D16, whether a stop's wait on an unanswered prompt is bounded, and what happens to a held prompt whose client has gone; then make the clients agree with that choice (the Emacs abort timeout, the prompt route's behaviour past `idleTimeout`).
The decision must keep what OW-jifibo's test "sends its clear only once ..." in `describe("PiAdapter stop (D16, OW-wisifo)")` in `src/server/adapters/pi/process.test.ts` asserts for an ordinary steer, or say why it gives that up.

## Done when

- The decision is in the `PiAdapter.abort` docblock and in D16 of `docs/DESIGN.md`.
- Case 1 has a test in `src/server/adapters/pi/process.test.ts`, red against OW-jifibo's `abort`, in which a stop issued behind an unanswered `/cmd` prompt reaches Pi as the decision says it should.
- Case 2 has a test, red first, at whichever layer the decision puts the fix, showing a held prompt whose client has gone is not later sent; or the decision records why it is.
- Case 3: `agentpane-abort`'s timeout matches the server's bound, with an ERT test in `emacs/agentpane-test.el` if the change is more than the constant.
- `bun run check` passes.

## Close note

Promoted to ark3/agentpane#12 during the card triage, 2026-10-31.
The owner wants the findings here measured again on current versions before any design; the issue opens with that re-measurement, then a design discussion, after which the work is split into fresh cards.
