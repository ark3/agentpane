---
labels: [defect]
---

# The browser's Detach leaves Send, Fork and Compact open while its close is in flight, so a prompt or fork POST attaches first and respawns the session being detached

The browser half of OW-dakeyi, which fixed the Emacs half on 2026-09-28 and decided to leave this one to its own card, since it lands in a different client and a different test suite.
In service of a detach in flight reaching nothing on the session it is closing, from either client.

`controller.detach` in `src/client/controller.ts` awaits `api.close`, which does not return until the server has disposed of the subprocess (`SessionManager.close` in `src/server/http/session-manager.ts` takes the session out of its table first, then awaits disposal, up to about a second plus a SIGKILL).
Its `detaching` set, added by OW-sugome, is read only by `recover`.
`detachable` and the Send button's `disabled=` in `src/client/App.svelte`, and `submit`, `forkAndSubmit` and `compact` in the controller, read nothing of it, so in that window a Send, a fork or a Compact still goes out.
The prompt and fork routes attach first (`src/server/http/app.ts`), so the server waits out the disposal and spawns the session again, running a turn the user then sees land on a preview; a second Detach sends a second `DELETE`.

What is load-bearing, as it was for OW-dakeyi: the detach in flight is state the controller already owns, and the paths that would reach the session read it, rather than a refusal clause added at each button.
OW-dakeyi's close note records how the Emacs side placed its reads (`agentpane--closing` in `emacs/agentpane.el`), for parity.

Done when tests in `src/client/controller.test.ts`, red first, hold `api.close` for the selected session and show `submit`, `forkAndSubmit`, `compact` and a second `detach` each calling nothing on `api` while it is held, and a test on `App.svelte` shows the Send, Compact and Detach controls disabled in that window; `bun run check` green.
Whether this needs `bun run test:browser` depends on whether the change touches the composer's action row, per `AGENTS.md`.
