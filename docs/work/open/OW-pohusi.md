---
labels: [defect]
---

# The browser drops its turn-done badge and follow for a prompt whose POST failed in transport, though the server may have admitted it, where agentpane-mode since OW-hiliti keeps its watch for anything but a refusal

Filed 2026-09-29 while landing OW-hiliti, from its implementer's note; read against 9c22139, nothing run in a browser.
In service of D25's promise that a server going away still ends a turn this client sent as an aborted turn does, and of the owner's rule that the two clients stay at parity (AGENTS.md, "Both clients").

## What happens

`controller.submit` in `src/client/controller.ts` returns `false` from its `catch` for any throw from `api.prompt`: a server refusal (an `ApiClientError` carrying the HTTP status), and equally a fetch that rejects in transport, the socket closing mid-request when the server dies.
`send` in `src/client/App.svelte` then calls `disarmSubmit`, whose docblock says "The submit those two armed never reached the backend (OW-mifuki)", and `watchAbandon` in `src/client/favicon.ts` takes down the badge watch and the pending follow.
A transport failure does not say the prompt never reached the backend: OW-hiliti measured, with a real server SIGKILLed while a prompt was in flight, that the socket's error was what the client saw in all 32 runs, whether or not the turn had been admitted (`resources/probes/emacs_helper_server_death_probe.el`; `docs/MANUAL_TESTING.md`, "only a refusal abandons a prompt's watch").
The `forkAndSubmit` path (`landed` false, also calling `disarmSubmit`) needs the same reading.

## What Emacs now does

`agentpane--request` in `emacs/agentpane.el` runs UNSENT, which abandons the watch, only for an error whose `data` carries the server's `status`.
Any other error leaves the outcome unknown, as a timeout does, and the watch stands; its docstring and D25 in `docs/DESIGN.md` state why.

## Done when

A client test, red first, fails the prompt POST with a transport error (a rejected fetch, not an `ApiClientError`) after arming, and asserts the badge watch and pending follow still stand, while a refusal (an `ApiClientError`, e.g. 409) still disarms them as today.
What the browser does with a watch left standing when its event stream then drops is part of the question: check what `watchAbandon`/`watchSubmit` and the stream-drop path do with it, and record the answer in the docblock of `disarmSubmit`.
`bun run check` passes.
