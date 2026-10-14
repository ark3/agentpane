---
labels: [defect]
blocked-by: [OW-dulipe]
---

# The browser keeps its turn-done badge and follow armed after a Pi prompt an extension command handled, so the next turn on that session badges this tab

Filed 2026-10-14 from OW-kokotu; read at the code, not run in a browser.
See `docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", paragraph "What each client shows, read at the code and not run".

`send()` in `src/client/App.svelte` calls `armFollow()` and `armBadge()` (which calls `watchSubmit` in `src/client/favicon.ts`) before `controller.submit()`, and takes both off through `disarmSubmit` only when the submit resolves `false`.
A Pi prompt such as `/mcp` that an extension command consumes is answered 202 and starts no turn (OW-dulipe), so both arms stay standing, and the next turn that streams on that session — another tab prompting it, or the user's next prompt — engages follow and badges this tab for a turn it did not ask for, which `disarmSubmit`'s docblock names as the thing the badge must never mean.
`controller.submit` in `src/client/controller.ts` also clears the draft on the 202, and nothing on screen says the prompt was consumed by a command.

Once OW-dulipe puts the handled outcome on the HTTP prompt route's answer, the browser should take both arms off for it and tell the user no turn followed; the wording is the executor's first cut.

## Done when

A test in `src/client/App.test.ts`, red first, answers a submit as handled and asserts no badge and no follow engage when a later turn streams on that session, and that the user is shown something saying the prompt started no turn.
`bun run check` passes.
