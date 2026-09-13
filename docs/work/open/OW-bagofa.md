---
labels: [deferral]
---

# Nothing catches the perf harness losing its Edit controls again

Surfaced while executing OW-sibebe and deliberately not done there.

OW-roveze made the transcript's Edit affordance conditional on the server's `forkPoints` answer, and `e2e/perf-harness.ts` kept answering `[]`, so every perf figure taken between those two changes was measured on a transcript one button per user message short of the app it stands for.
OW-sibebe fixed the harness but added no assertion, so the same silent divergence can reopen the next time either side moves.

The check that caught it is one line and needs a browser: drive the built harness at `sessions: 2, seedTurns: 5, otherTurns: 5` through `globalThis.perf.setup`, then count `.conversation [data-edit]`.
It gave 0 on the broken harness and 5 on the fixed one -- one per seeded user message.

The awkward part, and the reason this is a deferral rather than a defect: the perf vehicle has no assertions on purpose.
`e2e/perf-probe.ts`'s docblock says so -- "there is no assertion here, because the question it answers has a number for an answer, not a boolean" -- and `perf-probe.ts` is run by hand against a production build, not by `bun run test:browser`.
So the assertion has nowhere obvious to live: it is a boolean about the *harness*, not a number about the client, and `e2e/perf.html` is not currently loaded by any spec.

Load-bearing: that the guard is about harness fidelity, and that its natural home is a Playwright spec that loads `e2e/perf.html` -- a page no spec loads today.
Incidental: whether that spec is new or folded into an existing one, and whether it asserts only on Edit controls or on a broader fidelity property.

## Done when

A spec under `e2e/` fails on a `e2e/perf-harness.ts` whose `forkPoints` answers `[]` and passes on the one in `main`, and `bun run test:browser` stays green.
Show it red first by reverting that one method.

Alternatively, if the decision is that a spec loading `e2e/perf.html` is not worth its cost in the browser job, record that decision and its reasoning in the close note and close `--declined`; the divergence is then knowingly unguarded rather than forgotten.
