---
labels: [defect]
closed: done
---

# Five sites say a Claude Code fork has no store file until its first turn ends, which nothing measured

Filed 2026-10-15 from OW-letiyi's review, which corrected the "a fork is born without a file on every backend" claims and found these copies of a narrower one outside that card's list.

Five sites state, without a version, that a Claude Code fork's store file does not exist until its first turn ends, citing OW-japuzo:
- the `#pendingForks` docblock in `src/server/http/session-manager.ts` ("Claude Code's fork writes no store file until its first turn ends (OW-japuzo)");
- the `fork` docblock in `src/server/adapters/claude/adapter.ts` ("because the fork's store file does not exist until its first turn ends (OW-japuzo) and the session index therefore cannot find it");
- the comment opening with "Claude Code's shape (OW-razoki)" in `src/server/http/session-manager.test.ts` ("The fork's store file does not exist until its first turn ends (OW-japuzo)");
- `docs/DESIGN.md`, the sentence holding "`SessionManager.fork` parks that recipe in `#pendingForks`" ("a fork whose store file does not exist until its first turn ends");
- `resources/probes/fork_attach_probe.py`, the comment "its store file does not exist until the first turn ends (OW-japuzo)".

OW-japuzo never measured it: its fork cell in `resources/probes/claude_fork_probe.py` reads `store_file(fork_session_id)` only after the fork's `result`, and D9 now says so in its Claude Code bullet ("when the `--fork-session` process the attach spawns first writes was not measured").
The nearest measurement points the other way: on `claude 2.1.280` a fresh session's file appeared about 0.3s after its first user message, before any assistant event (`docs/MANUAL_TESTING.md`, "When a new Claude Code or Pi session first reaches disk (OW-bohodu)").
The load-bearing reason the index cannot answer at attach is a different one and is true by construction: `ClaudeAdapter.fork` spawns nothing, so no file can exist when it returns, which is how `src/server/http/app.ts` already puts it.
So the fix is a comment and doc change: each site gives that reason instead, or states the timing with a version if someone measures it; no code changes.

Two lesser items found in the same review belong here rather than in cards of their own:
- `docs/DESIGN.md` D27's detach paragraph says "attach replaces the `virtual:` id before any prompt (D9, as corrected by OW-bohodu) and a fork never has one"; since OW-hojefo a Codex fork at the first user message comes back from `fork` under a `virtual:` placeholder ref, which the attach renames, so the clause should say a fork has none once attached, or drop it.
- The Codex claim that `thread/fork` writes the rollout at once is stated without a version at `src/server/adapters/codex/adapter.ts` ("Codex flushes the forked rollout to disk here, before any turn"), `src/server/http/app.ts` ("Codex flushes that rollout to disk immediately"), and `src/server/http/session-manager.test.ts` ("Codex flushes the forked rollout at `thread/fork`"); D9's Codex bullet carries the versions (`codex-cli 0.154.0`, OW-lajehi; `0.156.0`, OW-sayaju), and each site needs one, or a pointer to D9.

## Done when

`rg -n 'does not exist until (its|the) first turn ends|writes no store file until its first turn' src docs resources --glob '!docs/work/**'` prints nothing, `rg -n 'a fork never has one' docs/DESIGN.md` prints nothing, and each "Codex flushes" site names a version or points at D9.
`bun run check` passes, since most sites are in `src/`.

## Close note

Landed in ed24d121, comments and docs only, bun run check green.
The five sites that said a Claude Code fork has no store file until its first turn ends now give the by-construction reason: ClaudeAdapter.fork spawns nothing, so no file can exist when it returns (OW-razoki); the OW-japuzo citations that backed the unmeasured timing are gone from those sites.
D27's detach paragraph now says a fork has no virtual: id once attached.
The three "Codex flushes" comments, plus the same claim in fork_attach_probe.py's docstring, name codex-cli 0.154.0 and point at D9 or OW-lajehi.
All three done-condition greps print nothing.
