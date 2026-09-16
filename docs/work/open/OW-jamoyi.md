---
labels: [unverified]
---

# Watch a real backend resume after Detach then Attach, live, and record it in OW-35

`src/client/App.svelte` (the `{#if previewing}` branch's Attach button), `src/server/http/app.ts` (the attach and prompt routes), OW-35, OW-tewave.

OW-tewave asked its implementer to prompt a session it had just detached and record what happened in OW-35.
Nothing was observed, so the clause fired neither way and became this card.
Two things were wrong with it, and this card is the corrected version.

The first is why nothing was observed, and it stands: the scenario needs a live server with a real backend subprocess behind it.
jsdom drives a fake API and so does the Playwright vehicle in `e2e/`; neither has a session manager, so neither can exercise any of this.

The second is that OW-tewave claimed Detach was the first UI path reaching OW-35's scenario without restarting the server, and that is false.
After a detach the preview loads, `previewing` goes true, and the whole composer is replaced by a single Attach button -- there is no prompt box, so a detached session cannot be prompted from this path at all.
OW-35 has been corrected to say so.

What is left is still worth watching, and nobody has: pressing that Attach button on a session whose subprocess was just killed by hand.
Detach then Attach is newly reachable from the UI and goes through the resume path D3/D9 describe, on a session this client itself ended moments earlier rather than one that was never attached in this process.

The run, on the home server, with the model pin `AGENTS.md` mandates and the CLI version named in whatever gets written down: start agentpane, attach a session, send a prompt and let the turn finish, Detach it from the Tools menu, then press Attach and send a second prompt.
Write down whether the transcript comes back, whether the backend has the first turn's context, and what the pane shows while the re-attach is happening.

Done when that observation is in OW-35, naming the backend, its version and the date.
It closes whichever way it comes out: a clean resume is as much an answer as a broken one, and a broken one becomes its own card with this one still closing.
