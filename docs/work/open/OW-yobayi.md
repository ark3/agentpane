---
labels: [defect]
blocked-by: [OW-dulipe]
---

# The browser keeps its turn-done badge and follow armed after a Pi prompt an extension command handled, so the next turn on that session badges this tab

Filed 2026-10-14 from OW-kokotu; read at the code, not run in a browser.
See `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", paragraph "What each client shows, read at the code and not run".

`send()` in `src/client/App.svelte` calls `armFollow()` and `armBadge()` (which calls `watchSubmit` in `src/client/favicon.ts`) before `controller.submit()`, and takes both off through `disarmSubmit` only when the submit resolves `false`.
A Pi prompt such as `/mcp` that an extension command consumes starts no turn, and `controller.submit` in `src/client/controller.ts` resolves `true` for it as for a started one, so both arms stay standing, and the next turn that streams on that session — another tab prompting it, or the user's next prompt — engages follow and badges this tab for a turn it did not ask for, which `disarmSubmit`'s docblock names as the thing the badge must never mean.
`controller.submit` also clears the draft for it, and nothing on screen says the prompt was consumed by a command.
The fork path in `send()` has the same hole: `forkAndSubmit` in `src/client/controller.ts` sends the fork's prompt through `api.prompt` as well, an edit to `/mcp` is handled the same way, and the follow and watch `send()` armed on the fork's handle stay standing because `forkAndSubmit` resolves the attached fork rather than `null`.
(Amended 2026-10-14 at execution: as filed this read "answered 202"; OW-dulipe has since landed, and the fork path was added because it is the same arming state.)

Once OW-dulipe puts the handled outcome on the HTTP prompt route's answer, the browser should take both arms off for it and tell the user no turn followed; the wording is the executor's first cut.
OW-dulipe's shape: the route answers a handled prompt 200 with `{ "disposition": "handled" }` (`PromptResponse` in `src/shared/protocol.ts`) and a started one 202 with no body, and `api.prompt` in `src/client/api.ts` resolves the body or nothing.
"Handled" means no turn was started for this prompt, not that nothing follows it on the stream.
Pi's installed `docs/rpc-commands.md`, "prompt", on `pi 1.2.0`, says the disposition "describes the submitted prompt, not independent work started by an extension", and Pi's own `examples/extensions/send-user-message.ts` registers `/ask`, which answers `handled` and then streams a whole turn through `pi.sendUserMessage` (read at the source, not run).
So the message to the user must not promise that nothing is coming, and a turn an extension starts this way is arguably the one the user asked for; decide what the arm does for it and say so in the test.

## Done when

A test in `src/client/App.test.ts`, red first, answers a submit as handled and asserts no badge and no follow engage when a later turn streams on that session, and that the user is shown something saying the prompt started no turn.
A second, also red first, does the same for a fork whose prompt is answered as handled.
`bun run check` passes.
