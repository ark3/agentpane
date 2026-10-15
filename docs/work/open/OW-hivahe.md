---
labels: [deferral]
---

# A Pi fork's session_start notify goes out under the parent's handle before the adapter learns of the move

Filed 2026-10-14 from OW-fusoba's adversarial read; judged not worth blocking that card on.

In service of each notice being shown on the session it belongs to, now that every Pi `notify` is a notice (`docs/DESIGN.md` D11, "Pi's `notify` is a notice.").

Read at Pi's source on `pi 1.2.0` (not run): the RPC `fork` handler in `dist/modes/rpc/rpc-mode.js` under the installed `@earendil-works/pi-coding-agent` awaits `runtimeHost.fork(...)`, whose `finishSessionReplacement` runs the rebind callback, and then awaits `rebindSession()` again, so extensions see `session_start` (reason `"fork"`) twice, both before the `fork` response.
`PiAdapter.fork` in `src/server/adapters/pi/process.ts` learns of the move only from the `get_state` after that response, through `moveTo(..., "fork")`, so a `notify` sent from those handlers reaches the manager's `onNotice` listener in `#start` of `src/server/http/session-manager.ts` while the adapter is still on the parent's container, and the broadcaster sends it under the parent's handle.
Nothing is lost: `#forkOnto` sets `fork.notices = parent.notices`, so the fork's snapshot carries it, and the parent's view gets `ended` right after.
What shows is that notice drawn briefly on the parent's view, and only when its text differs from a notice already held there (OW-piloni drops an identical one); with the home server's `auto-read-agents-refs.ts` the text is the same each time, so as of 2026-10-14 nothing visible happens.

Worth picking up if an extension whose `session_start` text varies per session shows up in use.
Done when a Pi fork whose extension notifies at `session_start` with text unlike any notice the parent holds produces no `notice` event under the parent's handle, shown by a `session-manager` or adapter test that fails first.
