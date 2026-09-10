---
labels: [deferral, now]
---

# `real-dirs.smoke.test.ts` walks the developer's home directory inside `bun run check`, so the gate's result depends on machine state

`src/server/sessions/real-dirs.smoke.test.ts`, "listSessions against the real dirs (smoke)": it calls `listSessions` with the default roots under the real `$HOME` and asserts the result is structurally valid and sorted.
It is the one test in the suite whose input is not in the repository.
On the home server it took 0.73 s of the 49 s run on 2026-09-09, and it passes on an empty home too, so it has never been observed red in CI, where the roots do not exist.
OW-votasi extended it to the Claude root and its close note calls it the smoke that showed the walker survives the real store.

The deferral: it earns its place as a local smoke, and it is the wrong shape for a gate.
A gate should fail the same way on every machine.
Move it behind an explicit script, `bun run test:smoke` or a vitest `--project`, and say in AGENTS.md when to run it, or leave it and record here that the owner accepts a machine-dependent gate.

## Done when

The test is either excluded from `bun run check` and reachable by a named script recorded in AGENTS.md, or this card closes `--declined` with the acceptance in its close note.

The owner accepts this machine-dependent gate because automatic coverage against live CLI stores is more valuable than an opt-in smoke test that is likely not to run.
The test remains in bun run check: it costs little, does not surface transcript content, tolerates absent stores, and can expose real format or layout drift that repository-controlled fixtures do not contain.
Deterministic fixture tests remain the reproducible path for diagnosis when the live-store smoke finds a new case.
