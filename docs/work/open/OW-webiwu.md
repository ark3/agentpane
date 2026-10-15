---
labels: [question]
---

# Should a Pi prompt an extension command handled clear the session's held turn error, given that some such commands start a turn and some start none

Filed 2026-10-14 from the adversarial read of OW-dulipe.
In service of the held error (OW-31, OW-bipume, OW-jokoto) meaning how the session's last turn ended, and going away only when something replaced it.

## What happens

`SessionManager.submit` in `src/server/http/session-manager.ts` clears the session's held error once the backend admits a prompt whose `priorErrorId` names it, and broadcasts `error-cleared`; every client drops the error there (OW-lohubo).
Since OW-dulipe, `BackendAdapter.submit` resolves a `PromptDisposition`, and a Pi prompt an extension command consumed resolves `"handled"`.
It still clears the error like any other admission: OW-dulipe's implementer first made a handled prompt keep the error, and review took that out because it was not the card's ask and the case below breaks it.

## Why it is not one answer

On `pi 1.2.0`, `/refs`, `/llama` and `/mcp` on the home server answered `handled` and no event followed (`docs/MANUAL_TESTING.md`, "A prompt an extension command handles", under OW-kokotu).
For those, clearing the error leaves the user looking at nothing where the last turn's failure was, with no new turn to replace it.
But Pi's installed `docs/rpc-commands.md`, "prompt", says the disposition "describes the submitted prompt, not independent work started by an extension", and Pi's own `examples/extensions/send-user-message.ts` registers `/ask`, which calls `pi.sendUserMessage(args)`: that prompt answers `handled` and then a whole turn streams.
Keeping the error on every handled prompt would leave a stale failure standing over a turn that succeeded.
Both readings are at Pi's source on `pi 1.2.0`; the `/ask` case was not run.

A rule tied to the disposition is a guard at the site that one of the two cases defeats.
The candidate that covers both ties clearing to a turn actually starting — the adapter's `agent_start`, or whatever event each adapter already maps to a turn's start — rather than to admission.
That moves the clear from `SessionManager.submit` to wherever a turn's start is observed, and the `priorErrorId` comparison has to travel with it.

## Done when

The owner decides between keeping today's rule (clear on admission, handled or not), clearing on a turn's start, or another, and the decision is recorded in `docs/DESIGN.md` beside the decision that already governs the held error.
Whatever the answer, if it changes behaviour a `defect` or `change` card carrying it is filed, with a test in `src/server/http/app.test.ts` "what a client that connects late is told (OW-bipume)" that goes red first.
