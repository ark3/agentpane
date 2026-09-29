---
labels: [deferral, sweep-0929]
---

# A dozen open cards are probably moot or rest on premises the code has since changed, and each needs closing or rewriting against it

Filed 2026-09-29 by a sweep of the open deck for consolidations, read against e1cf2e6 with nothing run.
The readers' evidence per card is below; each still wants confirming at the source before its card is closed or rewritten.
Cards whose stale premises another `sweep-0929` card already carries are not repeated here: OW-jofodu (OW-wukako), OW-66 and OW-jamaha (OW-fifaji), OW-wujuda (OW-zadupu), OW-13 (OW-bulanu).

## Probably moot, or no bug as written

- OW-pivuho: `dispose()` removes the adapter's holder from the connection synchronously and the child is killed only when the last holder leaves (`src/server/adapters/codex/connection.ts`), and requests route only to holders that can answer; so as written it looks unreachable.
  An unverified residual: a child that crashes on its own, its stdin destroyed by EPIPE while request lines still drain from stdout, makes `write` throw inside the async `reply` in `codex/process.ts`.
- OW-15: the `get_state` probe runs only while `!idResolved`, and the comment at that probe in `src/server/adapters/pi/process.ts` records that 0.84.1, 0.85.1 and 0.87.1 all named the session file at start.
- OW-vipito: the controller re-lists when the stream reopens (the "re-lists when the event stream comes back up" test in `src/client/controller.test.ts`), `docs/MANUAL_TESTING.md` measured the browser retrying forever, and under D25 a drop holds nothing live; one step of `e2e/event-stream.spec.ts` would settle it.
- OW-muyawi: the note it asks for exists in `src/client/session-state.ts` ("A snapshot never gaps -- it restarts the count"), and the OW-bipume snapshot test in `session-state.test.ts` applies a `seq: 0` snapshot over a view at seq 4; what is left is asserting the following `seq: 1` upsert is accepted with `recover` empty.
- OW-luwowo: under D25 decision 3 a browser reconnecting mid-shutdown holds nothing live and is told of the drop moments later; `disposeAll()` empties `#sessions` synchronously, so abort and compact already answer `not_attached`; it cites `liveRefs()`, now `liveHandles()`. A `--declined` close looks plausible.
- OW-21: a decision record with nothing left to do; its "selecting a session attaches it" is stale since a click previews, but the picker is drawn only in live mode, so its conclusion holds.

## Premises to rewrite

- OW-19: "That is a work-laptop job" is false since Codex runs on the home server (`AGENTS.md`); its fixture list omits `subagent`.
- OW-yayugi: "no consumer" is contradicted by OW-zabiko and OW-yobuyi, which both cite `bun run src/emacs/dump-nodes.ts` as the instrument their evidence came from.
- OW-zugetu: its "From `reconcile`" bullet is dead, since OW-yibijo retired `reconcile` for `dropDead` in `src/emacs/helper.ts`; the other paths it names stand.
- OW-wawipu: a Claude Code CLI measurement with nothing Emacs in it, labelled `emacs`.
- OW-40: `POST /api/sessions` now rejects a non-absolute `cwd` in `src/server/http/app.ts`, though it still does not check the directory exists.
- OW-9: still true (Codex `setModel` in `codex/adapter.ts` never calls `reducer.setIdentity`) but it has no done condition.
- OW-7: real, but in client code (`Transcript.svelte` and `toolState` in `src/client/render/types.ts`), not the Codex reducer it names.
- OW-luzipe: its blocker OW-lisaye is closed; the same "O(1) per token" wording also sits in `SessionManager`'s `#onUpdate` docblock, which its doc fix should cover.

## Done when

Each card listed is closed with a note giving the evidence, or rewritten so its body matches the code, having been checked at the source first.
Nothing here changes code.
