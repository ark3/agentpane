---
labels: [defect]
---

# Comments and D9 say a fork is born without a file on every backend, which Pi and Codex forks at a later message were measured to contradict

Filed 2026-10-14 from OW-tigaye's implementer, which noticed these sites and left them, being outside that card's list.

Several places state as a rule that a fork starts with no store file on every backend:
- the `onDisk` docblock on `SessionSummary` in `src/shared/protocol.ts` ("a fork is born without a file, and neither is on disk until a turn writes it (D9)");
- `docs/DESIGN.md` D9, "a fork's container starts with it clear and no file behind it (OW-japuzo, OW-hojefo)", and the D27 marks rule, "which also covers a fork born without a file";
- the `describe("onDisk")` docblock in `src/server/http/session-manager.test.ts` ("a fork starts with no file on every backend (OW-wedupe)");
- the comment above "clears the selection onto the startup view when the detached fork has run no turn" in `src/client/controller.test.ts` ("A fork is born with no file on every backend, and gets one only when its first turn ends").

Measured against them:
- Pi, a fork at the second user message: the moved-to file was on disk when `fork` returned, carrying the rewound prefix, on `pi 0.85.1` (`docs/MANUAL_TESTING.md`, OW-gajesu) and `pi 1.2.0` (OW-vijine, OW-tigaye).
- Pi, a fork at the first user message: no file when `fork` returned on `pi 1.2.0`, written with the branch's first user message (OW-tigaye).
- Codex: "The fork's rollout was on disk when the request returned" (`docs/MANUAL_TESTING.md`, the OW-hojefo-era section holding "`thread/fork` carries neither the model nor the effort."; check the version it names there).
- Claude Code: OW-japuzo's section is where its fork's file timing was measured; read what it says before scoping.

Nothing in the code depends on the false half: `#forkOnto` in `src/server/http/session-manager.ts` starts every fork at `onDisk: false` and the session index's listing sets it true (`live.onDisk = true` in the listing merge), so a fork that does have a file is only reported late.
So this is a documentation defect, in service of no reader building on "a fork has no file" — for instance the marks rule in D27, which reads as if a fork could never be marked before a turn.
The two open cards that repeat the phrase, OW-vezipo and OW-66, are for whoever executes them to read against this; amend them only if their reasoning depends on it.

## Done when

Each site above states, per backend and with the version and fork point measured, whether a fork's file exists when the fork returns, or drops the claim where the sentence does not need it; `rg -n -i 'born with(out)? (a|no) file|starts with no file|no file on every backend' src docs --glob '!docs/work/**'` prints nothing unscoped.
`bun run check` passes, since two of the sites are in `src/`.
