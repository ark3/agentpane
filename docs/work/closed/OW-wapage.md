---
labels: [question]
closed: done
---

# The Codex compaction marker could carry a real summary in the preview but never in the live transcript

`src/server/sessions/codex.ts`, `compactionTurnFor` -- the `compactionSummary` turn it returns hardcodes `summary: ""`.
`src/server/adapters/codex/mapping.ts`, `compactionMarker` -- the live path's does the same.

Noticed by OW-bisubi's implementer while reading rollouts, and deliberately left.

A rollout's `{"type":"compacted"}` record carries `payload.message`, and on the rollouts read on the home server 2026-09-13 (`codex-cli` 0.150.1 and 0.153.0) that field holds prose that reads as the compaction summary Codex wrote.
The live app-server stream has no equivalent: the `contextCompaction` thread item is `{type, id}` and nothing else, which is why `compactionMarker` takes only a timestamp and a figure.

So the preview *could* show a summary the live transcript structurally cannot.
`src/client/render/Message.svelte` already renders `message.summary` when non-empty -- Pi's marker supplies one -- so nothing new would have to be built to show it.

## The decision nobody has made

Whether the two Codex surfaces may differ here.
OW-kelomi and OW-bisubi both argued the opposite way about the token figure: one event seen on two surfaces must not read differently, and a reader with both open must be able to tell they are the same event.
That argument applied to `summary` says leave it empty.
The counter-argument is that a summary is information the reader wants and the preview is the only Codex surface that can ever have it, so suppressing it costs the reader something real to buy a consistency they may not notice.

Note this is not the same asymmetry as the token figure: there, both surfaces could reach the same quantity and one simply did not. Here, one surface structurally cannot.

## Done when

The decision is recorded where the next reader meets it: a line in `docs/DESIGN.md` if it rises to a decision, or a comment at `compactionTurnFor`'s `summary: ""` naming what `payload.message` holds and why it is not used.
If the decision is to show it, that also means a preview test asserting the summary reaches the turn, watched red first.

Load-bearing: that a reader who later finds `payload.message` sitting unused does not have to re-derive why.
Incidental: which way it goes.

## Amended 2026-09-30 by OW-zadupu

Measured on the home server on `codex-cli 0.157.1` with `gpt-5.6-luna`, `resources/fixtures/codex/compact-rollout.rollout.jsonl` beside the stream of the same run; `docs/MANUAL_TESTING.md`, "Codex fixtures that keep their rollout (OW-zadupu)".
On that version the `compacted` record's `message` is `""`, and its only other content is an encrypted compaction item, so the preview has no summary to show either.
Live and preview agree on that run: both draw one compaction marker with an empty summary and `tokensBefore` 11778, and `src/server/sessions/codex-conformance.test.ts` holds them to it.
So the premise "the preview could carry a real summary" held on the 0.150.1 and 0.153.0 rollouts and does not on 0.157.1; the decision is now only what to do for rollouts older versions wrote, and recording that at `compactionTurnFor` still closes this card.

## Close note

The premise did not reproduce. On 2026-10-01 every `compacted` record in the home server's `~/.codex/sessions` had an empty `payload.message`: one rollout each from `codex-cli` 0.147.0, 0.150.1 and 0.153.0, apparently the same rollouts the 2026-09-13 reading covered. OW-zadupu's 0.157.1 capture is empty too. What Codex keeps is `replacement_history`, holding the surviving user messages and a `compaction` item that is encrypted (2–12 KB), so neither surface has a readable summary to show, and the question of whether they may differ does not arise.
Why the 2026-09-13 reading saw prose is unknown, since those files may differ from these.
Recorded as the comment at `compactionTurnFor`'s `summary: ""` in `src/server/sessions/codex.ts`, which names this card for the case that a readable summary ever appears. `bun run check` passes.
