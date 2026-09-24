---
labels: [defect]
closed: done
---

# A failed Codex turn shows its upstream error as raw JSON, and Emacs shows it twice

Found while executing OW-wawuzu; the live run is in `docs/MANUAL_TESTING.md`, section "What a Codex turn on a model that does not exist does".
On `codex-cli 0.156.0`, a turn the upstream API refuses reaches agentpane as an `error` notification and then a `turn/completed` with `status: "failed"`, both carrying the same `error.message`.
That message is the upstream response serialized as a string, for example `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'agentpane-no-such-model' model is not supported when using Codex with a ChatGPT account."}}`.

Two things follow, both in `src/server/adapters/codex/reducer.ts`.
The `case "error"` and the failed branch of `case "turn/completed"` each emit an `error` effect, so every such failure reaches the wire as two identical `error` events.
The browser hides the duplicate, since `src/client/session-state.ts` overwrites `view.error`, but the Emacs client appends an `(:error MESSAGE)` node per event (`agentpane--upsert` in `emacs/agentpane.el`, "always appends"), so the user sees the line twice.
And neither client unwraps the string, so the banner and the Emacs line show raw JSON where the inner `error.message` is the sentence a user needs.
The `error` case also ignores `willRetry`; the vendored `resources/codex-protocol/v2/ErrorNotification.ts` carries it, and whether a retrying error should surface at all is part of this card's decision.

A made-up model is only one way to provoke it: `POST /api/sessions/codex/<id>/model` with `agentpane-no-such-model` and then a prompt fails before any model runs and reported no tokens on that run, under the one-off exception the owner granted OW-wawuzu.
That exception does not carry over, so a live reproduction here needs the owner's leave again; the fixtures under `resources/fixtures/codex/` and the reducer's tests are the cheaper vehicle.

The fix is server-side, in the reducer, so both clients get it from the one change, as the both-clients rule in `AGENTS.md` asks.
Done when a reducer test fed an `error` notification and a failed `turn/completed` carrying the same upstream error yields one `error` effect whose message is the inner `error.message`, red before the change and green after.

## Close note

Landed as 43d4fde, server-side in `src/server/adapters/codex/reducer.ts`, so both clients get it without a client change.
A non-retrying `error` notification records its turn id in `reportedErrorTurnId`, and a failed `turn/completed` for that same turn emits no second `error` effect; a failed turn with no preceding notification still reports.
`upstreamMessage()` unwraps a message that parses as `{ error: { message: string } }` to the inner sentence and passes plain text through, for both sources.
Decided here: an `error` with `willRetry: true` emits nothing, does not count as reported, and leaves a pending compaction in place, because Codex is still running the turn — a banner would go stale over a retry that succeeds, and clearing compaction would reopen `CodexAdapter.submit`'s steer path into a compact turn still live.
That reading is from `resources/codex-protocol/v2/ErrorNotification.ts`, not a live run.
Verified by four new tests in `reducer.test.ts` ("defensive handling"): three failed against the old reducer and pass now (re-run by the dispatching session); the later-turn test was shown able to fail by mutating the dedup to be global, then reverted.
`bun run check` passed.
No live Codex run; the dropped `warning` notification the same live run saw is filed as OW-fomebu.
