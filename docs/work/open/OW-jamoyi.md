---
labels: [unverified]
---

# Observe what prompting a just-detached session does, live, and record it in OW-35

OW-tewave's Detach item is the first UI path that reaches OW-35's scenario -- prompting a session whose subprocess is gone -- without restarting the server.
That card asked its implementer to record whatever it observed when prompting a session just detached from the menu.
Nothing was observed, so the clause fits neither branch and becomes this card rather than a skip.

Why nothing was observed: the scenario needs a live server with a real backend subprocess behind it.
jsdom drives a fake API, and the Playwright vehicle in `e2e/` does too -- neither has a session manager, so neither can exercise the prompt route's attach-before-submit path.
The implementer was told not to run the app and did not.

The work is one live run on the home server, with the model pin AGENTS.md mandates and the CLI version named in what gets written down: start agentpane, attach a session, let a turn finish, Detach it from the Tools menu, then prompt it from the read-only view's Attach button and prompt again, and write down what actually happens -- whether the re-attach is transparent as `src/server/http/app.ts`'s prompt route intends, and what the transcript pane shows while it happens.

Done when that observation is in OW-35, naming the backend, its version and the date.
It closes whichever way the observation comes out: a clean transparent re-attach is as much an answer as a broken one, and if it is broken that becomes its own card with this one still closing.
