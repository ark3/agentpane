---
labels: [unverified]
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
