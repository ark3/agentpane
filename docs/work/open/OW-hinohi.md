---
labels: [defect]
---

# bun run check takes about 62s on the home server against the 40s AGENTS.md records, and nobody has profiled where the 22s went

AGENTS.md, under "Commands", says `bun run check` is "about 40s on the home server's 4 cores as of 2026-09-11 -- and a run that drifts well past that is a defect to profile, not a reason to skip it".
On 2026-10-01, at 9df26a1, two runs took 64s (a dispatched implementer's, in `.worktrees/OW-9`) and 62s (on `main`, `uptime` load average 1.72 / 2.25 / 2.15 at the start, so other work was sharing the cores).
The 62s run's log split as vitest `Duration 36.34s` over 56 files and 1614 tests, the rest svelte-check plus process start; neither half's 2026-09-11 figure is on record, so which grew is not known.

In service of keeping the check cheap enough to run before every commit.
A prior attempt bears on it: splitting `App.test.ts` made the run slower and was reverted on 2026-09-11, because the wall time is per-file overhead over three workers plus a cold Svelte compile, so file count matters more than test count.

## Done when

The time is split by phase on an idle machine (load average under 0.5) -- svelte-check alone, `bun run test` alone -- and each is compared with `git checkout` of the last commit on or before 2026-09-11 run the same way.
Either the regression is found and fixed, with the before and after timings in the commit message, or the 40s figure in AGENTS.md is corrected to the measured one with the reason it grew; AGENTS.md's number is current either way.
