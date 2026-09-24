---
labels: [defect]
closed: done
---

# D9 says a virtual session materialises on its first prompt; Pi has materialised at attach since 0.84.1, in ~23 places

The claim reads, in various wordings, "a virtual session materialises on its first prompt", and it is D9's design contract that every other copy is quoting.
Find the copies with `rg 'materialis|first prompt' src/ docs/` and discard the test files; roughly 23 non-test copies stand, about 16 of them in code.
The ones to read first, because they are the most confidently wrong or the most load-bearing:

- `docs/DESIGN.md` D9 holds four, and it is the authority the rest cite.
- `src/server/http/session-manager.ts` holds three, including `markPrompted`'s docblock: "Mark a virtual session as materialised. Called on the first prompt (D9)."
- `src/server/adapters/pi/process.ts` holds five, two of them beside state the adapter carries across a rename.
- `src/shared/protocol.ts` holds three, including the `SessionStatus` doc comment's `virtual` bullet and "nothing hits disk until the first prompt" on the create route.
- `src/client/App.svelte` four, `src/client/controller.ts` one in `detach()`'s virtual-exit docblock, `src/client/favicon.ts` one, `docs/WORKSTREAMS.md` one, and `docs/HANDOFF.md` two -- the two in HANDOFF are the *correct* ones and are the reason this card exists.

**This is a reconciliation card, not a discovery.**
`docs/HANDOFF.md` finding 41 measured the truth on `pi 0.84.1`: "Pi names its session file during `start()`, not on the first prompt … the id changes during **attach** and that second probe never fires", verified by a live `renamed` event observed before any prompt was sent.
A live run on 2026-09-16 re-confirmed it on `pi 0.85.1` and added the resume half -- no second `renamed` after a re-attach, because the id is already final (`docs/MANUAL_TESTING.md`, "`DELETE` then attach resumes a real Pi session", OW-jamoyi).
So the fact has been recorded and contradicted in the same repository for weeks, and the work here is retiring the copies that never heard, which is what `AGENTS.md`'s "the same change retires every copy" rule asks for.

**Do not delete the first-prompt path.**
Finding 41 says why and the caution is the load-bearing constraint on this card: a `virtual` session whose backend has not yet written a file is exactly what D9 describes, and Pi's startup write may be a property of how `pi --mode rpc` starts rather than a promise.
So this is a correction to what the comments claim, plus a decision about what D9 should say, and explicitly not a code removal.

A boundary on how far the sweep may claim: the backends differ, so the shared copies in `src/shared/protocol.ts` and D9 must not be rewritten as if one backend's behaviour were all three's.
Pi writes its session file at attach, as above.
Codex, as of `codex-cli 0.156.0`, gives the session its thread id at attach -- `CodexAdapter.start()` runs `thread/start`, and the session manager renames the `virtual:` ref then -- but writes no rollout until the first turn; `thread/resume` of a turnless thread failed with `-32600 no rollout found for thread id` (`docs/MANUAL_TESTING.md`, "What a Codex fork at the first user message keeps, and what could keep nothing (OW-hojefo)").
So on Codex a non-`virtual:` id does not mean anything is on disk; OW-wedupe is the code that depends on that reading, and it is fixed there, not here.
Claude Code is unmeasured: measure it with no turn -- spawn a fresh session as agentpane does and look for its store file before any prompt -- or have D9 say it is not known.

What is not yet known, and is why this is not a pure comment sweep: whether any site *depends* on the stale reading or merely describes it.
`detach()`'s virtual exit is the reassuring case -- its predicate `selected.id.startsWith("virtual:")` is still correct, since the id is `virtual:` exactly while nothing is on disk, and only its stated reason is wrong.
Confirm the same of the others rather than assuming it; a site that turns out to depend on it is its own defect and its own card.

Load-bearing: that attach, not the first prompt, is when Pi writes the file, and that finding 41 already says so.
Incidental: the wording each site lands on.

Done when `rg 'materialis|first prompt' src/ docs/` read through by hand leaves no copy asserting the false version, D9 says what is actually true and names the version it was measured on, and `bun run check` is green.

## Close note

D9 corrected and every non-test copy of "a virtual session materialises on its first prompt" retired, in two docs commits on main: "docs: record when a new Claude Code or Pi session first reaches disk (OW-bohodu)" and "docs: say in D9 that every backend renames at attach and writes at the first turn (OW-bohodu)".

The measurement overturned part of the card's premise.
Live on the home server, 2026-09-23: `claude 2.1.280` (spawned as ClaudeAdapter does, `--model haiku`) wrote nothing under `~/.claude` in 15 s with no prompt, and its store file appeared 0.3 s after the first user message; `pi 0.87.1` named its sessionFile from `get_state` at start but the file did not exist until the first turn's reply ended, confirmed in Pi's source (`_persist` in `dist/core/session-manager.js` writes nothing until an assistant message exists).
Pi was run outside sbox with a throwaway PI_CODING_AGENT_DIR, because this session's sandbox mounts `~/.pi/agent` read-only.
With Codex from OW-hojefo (`codex-cli 0.156.0`), all three backends replace the `virtual:` id at attach and none writes before the first turn.
HANDOFF finding 41 had read "the file already exists" at start from a rename that shows only the name; the row now says named, not written.
Recorded in `docs/MANUAL_TESTING.md`, "When a new Claude Code or Pi session first reaches disk (OW-bohodu)".

D9 now says this per backend with versions, keeps the first-prompt path (Pi's post-submit get_state probe, markPrompted, the fake's materialiseOnSubmit) as the case `virtual` describes, and says neither a non-`virtual:` id nor a cleared `virtual` flag means a file exists.
No code changed.

Dependence: `detach()`'s `selected.id.startsWith("virtual:")` exit in `src/client/controller.ts` depends on the stale reading on every backend, not only Codex, and forks reach the same state; OW-wedupe was widened to carry that, and D21 notes it.
Everything else read (SessionManager's fromStore/index, App.svelte `detachable`, the model gates, the Emacs client, the unbuilt D12 reaper) decides from state, not the id prefix, and is safe.
Test-file comments were out of scope and went to OW-yoyabo.

Verified: bun run check green (54 files, 1249 tests); an adversarial reader traced each new claim to the code and found two missed copies (fork_attach_probe.py, D21) and three over-claims, all fixed before landing.
