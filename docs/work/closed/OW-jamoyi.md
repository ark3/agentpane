---
labels: [unverified]
closed: done
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

## Close note

Observed, and recorded in OW-35 (the card's done condition) and in `docs/MANUAL_TESTING.md` under "`DELETE` then attach resumes a real Pi session, and the resumed spawn drops the model".
Home server, 2026-09-16, `pi 0.85.1` on `openrouter/deepseek/deepseek-v4.1-flash:high`, driven at the HTTP routes with `curl` against `bun run start`.
No browser was open and the Attach button was never pressed: the resume is proven at the routes, and the UI path is still unobserved, which is said plainly in both places.

The answer is that the resume is clean.
The re-attach's snapshot carried both of turn 1's messages, and the second turn -- on a process spawned after the kill was confirmed dead by pid -- answered two facts planted in turn 1, which it could have read nowhere but the resumed JSONL.
So `--session <resumeId>` rehydrates the conversation into the backend and not merely into the client, which is what OW-35's transparent re-attach had been assuming without evidence.

Three findings, each filed rather than fixed.
OW-pubulu: the resumed spawn carries `--session` and no `--model`, structurally, because `close()` drops the session and `#start`'s `!session` branch rebuilds it with no model key -- and `SessionSummary` has no `model` field for it to restore. The run could not tell what the resumed process ran on, because the settings default happened to match the pin on both model and thinking level; the card carries the experiment that would settle it.
OW-pizaki: `POST /model` rejects the `:thinkingLevel` suffix that `--model` accepts, answering 500 where 400 belongs -- so the exact string `AGENTS.md` mandates for the pin is valid at spawn and invalid after it.
OW-bohodu: D9's "materialises on its first prompt" is restated in roughly 23 non-test places while `docs/HANDOFF.md` finding 41 measured the opposite on `pi 0.84.1`; this run re-confirms it on 0.85.1 and adds that a re-attach is not a rename point at all.

The `sbox` gotcha the run hit first is in `docs/HANDOFF.md` under "Environment gotchas": a `cwd` under `/tmp` has no workspace `sbox` can detect, and the spawn fails with `Could not detect workspace` before the backend is reached; `touch .sandbox-workspace` in that directory is enough.

Worth knowing about this close: the first write-up claimed more than the run earned, and an adversarial reader caught it.
The cache-read numbers corroborate the resume rather than proving it; "byte-identical" was three named fields; `seq: 0` is `broadcastSnapshot`'s unconditional reset and not `broadcaster.forget()`'s; and the attach-time materialisation was written as a discovery with a fabricated cause, when the Attach button predates OW-tewave by a month (26d104f, 2026-08-14) and finding 41 had the fact already.
All four are corrected in what landed.
