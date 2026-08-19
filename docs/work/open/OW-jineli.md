---
kind: defect
where: '`src/client/App.svelte:106-108`'
---

# The sidebar re-sorts the whole session corpus on every SSE event, because the sort depends on `view` rather than on the array it sorts.

`sortedSummaries` reads `view.state.summaries`, so it is invalidated by every
publish — and `publish()` fires per streaming token, for every session. Nothing
in an `upsert` touches `summaries`: `reduceServerEvent` replaces only
`state.sessions` and carries the same array reference through. The sort runs
anyway, `Date.parse` twice per comparison via `recency`.

Measured 2026-08-19 with `e2e/perf-harness.ts` against a production build, on
top of OW-detepa's fix (which has to land first for this to be visible at all —
before it, the deep-proxy cost buries this one). At 400 listed sessions,
`recency` was 8-15% of the remaining per-event self time. Memoising it:

| | selected streams | background streams |
| --- | --- | --- |
| 180 msgs, 400 sessions | 8.0 -> **6.3ms** | 3.3 -> **1.9ms** |
| 15 msgs, 400 sessions | 3.8 -> **1.9ms** | 1.6 -> **0.6ms** |

The corpus size this scales with is not hypothetical: D9 measured ~973 stored
sessions (HANDOFF 19), and the list is unfiltered by default.

## The shape of the fix

A derived between `view` and the sort, so the sort depends on the *array*:

```
const summaries = $derived(view.state.summaries);
const sortedSummaries = $derived([...summaries].sort((a, b) => recency(b) - recency(a)));
```

`summaries` still recomputes on every publish, but returns an identical
reference, and a derived that recomputes to an equal value does not invalidate
its consumers — Svelte's own `update_derived` gates on `!derived.equals(value)`,
in `reactivity/deriveds.js`. So the sort runs on a re-list and not on a token.
This only works because OW-detepa makes `view` raw — under the deep proxy the
array reference changes every publish and the memo buys nothing. Note that
dependency in the code, or the next person to touch `:19` will silently undo
this.

`bun run check` and `bun run test:browser` pass with both changes.

## Done when

A test that fails before and passes after, counting rather than timing: spy on
the comparator (or on a small exported `recency`) and assert that an `upsert`
for any session produces **zero** calls, while a `sessions-changed` refresh
still produces a sort. Same vehicle as OW-detepa's — `App.test.ts` drives
`reduceServerEvent` directly at `:348`.

Re-measure with `bun e2e/perf-probe.ts`, whose `sessions: 400` scenario exists
for this, and record the figures in `docs/MANUAL_TESTING.md`.

The same "depends on `view`, not on what it reads" shape is worth a look across
the other deriveds in the file — `selectedSummary` runs a `find` over the same
array on every event — but that is a smaller cost and not measured; do not widen
this item into a sweep without numbers.
