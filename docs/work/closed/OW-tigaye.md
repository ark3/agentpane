---
labels: [unverified]
closed: done
---

# Pi refuses a fork before the session's first assistant message, and a first-message fork's file is not on disk when fork returns; neither is measured or recorded

Filed 2026-10-01 by OW-geselo, whose reader settled the `SessionManager.fork` docblock from the Pi source rather than from a run.
Two facts about Pi forks were read in the installed `pi 0.87.1` source on the home server and nowhere measured, and the repo records neither.

1. Pi refuses to fork a session whose file is not yet on disk.
   The runtime `fork` checks `existsSync(currentSessionFile)` before tearing anything down and throws "This session has not been saved yet. Wait for the first assistant response before cloning or forking it." (the string is in `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/`).
   The file first appears when an assistant message entry exists (`_persist` in `session-manager.js`; MANUAL_TESTING OW-bohodu measured it appearing just after `agent_end` on 0.87.1).
   That refusal is what makes the "still on disk" in `SessionManager.fork`'s docblock ("Where the ref DOES change, which is Pi alone") hold for every fork that succeeds; and both clients abort a streaming Pi turn before forking (`src/client/controller.ts`, `emacs/agentpane.el`), whose assistant `message_end` writes the file first, which is why their first-turn forks succeed rather than meet it.
   The server's fork route aborts nothing, so a raw HTTP or JSON-RPC fork during the first turn reaches the refusal, and what agentpane answers then is unmeasured.
2. A fork at the first user message leaves the new branch holding no assistant message, so `createBranchedSession` defers writing it: the fork's file is not on disk when `fork` returns.
   It takes that path, rather than the `newSession` one that skips the check, because the first user message has a parent: `sdk.js` always appends a `thinking_level_change` to a new session.
   `AGENTS.md`'s Pi fork bullet under "Evidence" says "The 0.85.1 and 1.2.0 runs also read the fork's moved-to session file as already on disk when `fork` returned, carrying the rewound prefix" (the `1.2.0` runs are OW-vijine's, added 2026-10-14); those were forks at a later message and do not generalise to the first.
   `#forkOnto` in `src/server/http/session-manager.ts` already tolerates the absence with `onDisk: false`.

In service of the fork records being true for every fork point, so nobody builds on "the fork's file is on disk" for a first-message fork.
Load-bearing: the version, and which message the fork is taken at.

## Done when

A live run on the home server (`pi --model openrouter/deepseek/deepseek-v4.1-flash:high`, version named) is recorded in `docs/MANUAL_TESTING.md`, settling both: what a `fork` sent before the first assistant message answers, at Pi's RPC and through agentpane's fork route; and whether a first-user-message fork's file exists when `fork` returns.
`AGENTS.md`'s Pi fork bullet is scoped to what each run measured, and so are the other copies of "the fork's file is on disk when `fork` returns": the comment in `PiAdapter.fork` in `src/server/adapters/pi/process.ts` ("found that new file already on disk when the fork returned") and `docs/MANUAL_TESTING.md`'s "A fork the user then discards therefore costs a real session file".

## Amended 2026-10-14: Pi may now write the file at the first user message

The home server's `pi --version` reported `1.2.0` on 2026-10-14, and Pi's changelog for `0.99.0` reads "The session file is now created when the first user message is sent", rather than once an assistant message exists.
That is the precondition both facts above rest on: if it holds, the refusal in fact 1 may fire only before the first prompt, and a first-message fork's new branch may be written at once rather than deferred.
So the run this card asks for is made on the installed `pi`, now `1.2.0`, and settles when the file first appears as well as the two facts.
Whatever it shows, every copy of OW-bohodu's `0.87.1` finding that the file appears only once the first reply ends is scoped to its version or retired: the `ref` and `idResolved` docblocks on `PiAdapter` in `src/server/adapters/pi/process.ts` ("writes no file there until the first turn's reply ends"), the fact-1 sentence above, and whatever a grep for "OW-bohodu" turns up in `docs/` and `src/`.

Amended again 2026-10-14 at execution: the `AGENTS.md` quote above gained "and 1.2.0" from OW-vijine's runs since filing, and `docs/MANUAL_TESTING.md`'s OW-vijine section already cites the `0.99.0` changelog line ("changed nothing these runs needed, since every one forked from a file a turn had already written"), which this run's result may need to qualify too.

## Close note

Measured live on the home server 2026-10-14 on `pi 1.2.0`, model pinned `openrouter/deepseek/deepseek-v4.1-flash:high`, two recorded runs of the new `resources/probes/agentpane_pi_fork_first_turn_probe.py` (plus two draft passes that agreed); recorded in `docs/MANUAL_TESTING.md`, "A Pi session's file appears at its first user message, and a fork at that message has none when `fork` returns (OW-tigaye)".

Findings, all on `pi 1.2.0`:
- When the file appears: named by `start()`'s `get_state`, absent before any prompt and through the user message's `message_start`, present from the first user message's `message_end` (16–22 ms after the prompt write, before any assistant event). OW-bohodu's `0.87.1` "only once the first reply ends" no longer holds; every copy is now version-scoped.
- A fork before the first assistant reply, at Pi's RPC: before any prompt there are no fork points; `fork` at a bad id or a setup entry answers `Invalid entry ID for forking`; only `clone` reaches "This session has not been saved yet. Send a message before cloning or forking it." During the first turn a fork at the first user message (sent at the 30th `text_delta`) succeeds, the turn stops `aborted`, `agent_settled` precedes the response, and the parent file keeps the partial reply. Read at source: the not-saved refusal is unreachable through `fork` on 1.2.0; on 0.87.1 (source only) a first-turn fork would have met it.
- Through agentpane's HTTP fork route: before any prompt, a bad `entryId` answered 500 `internal_error` "Invalid entry ID for forking", session unharmed; during the first turn, a fork at the first user message answered 201 in 0.18 s, the parent got `status` not-streaming then `ended`, and the fork attached and ran a turn. Emacs JSON-RPC not driven (passes the status through, read at code). The 500 is filed as OW-rasiwa.
- Is the fork's file on disk when `fork` returns: at the first user message, no (RPC and agentpane, still absent 3 s later; written with the branch's first user message); at the second user message, yes, carrying the rewound prefix. The earlier 0.85.1/1.2.0 on-disk samples were all second-message forks, and every copy of that claim (AGENTS.md Pi fork bullet, `PiAdapter.fork` comment, MANUAL_TESTING OW-pifowo/OW-gajesu/OW-vijine sites, `fork_probe.py`) now names the fork point.

Also scoped: D9 in `docs/DESIGN.md`, HANDOFF finding 41, the `ref`/`idResolved` docblocks and the `submit` comment in `src/server/adapters/pi/process.ts` (comments only), and OW-bohodu's "not measured" stopped-turn note. An adversarial reader checked every number against the raw run JSON and the source claims against Pi 0.87.1 and 1.2.0; its corrections landed. `bun run check` passed (1654 tests). Pre-existing "a fork is born without a file on every backend" claims, contradicted by Pi and Codex later-message forks, are filed as OW-letiyi.
