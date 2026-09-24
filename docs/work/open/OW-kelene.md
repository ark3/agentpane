---
labels: [change]
blocked-by: [OW-riluye]
---

# Codex fork points and resume hydration load a thread's whole history, which codex-cli 0.156.0 deprecates for paginated threads

On 2026-09-24 a Codex session in agentpane showed this notice, surfaced by OW-tujiya: "Full-history hydration is deprecated for paginated threads; omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`."
Deprecated is not removed, so nothing is broken today, but a later `codex-cli` that drops full-history hydration would break reattaching a Codex session and forking or editing one, and this project never rolls a CLI back.
OW-riluye regenerates the vendored bindings, which lack the whole pagination API; this card is blocked on it.

## Where agentpane hydrates the whole history

All in `src/server/adapters/codex/adapter.ts`:

- `listForkPoints()` sends `thread/read` with `includeTurns: true`, and `fork()` calls it through `rememberTurns` when `turnOrder` is empty.
  The notice names `includeTurns`, so this is the likeliest source of the one seen.
- `start()` repaints a reattached session from the turns `thread/resume` returns (the branch that calls `rememberTurns(started.thread)`), which `CodexReducer`'s cold-start replay in `src/server/adapters/codex/reducer.ts` consumes (its docblock opening "Cold start (D3)").
- The borrower's `thread/resume` for a fork's adapter (the `rememberTurns(resumed.thread)` call).

## The API, as of `codex-cli 0.156.0`

Read from bindings generated from the installed CLI, once OW-riluye has vendored them:

- `Thread.historyMode` is `"legacy" | "paginated"`.
- `thread/turns/list` (`ThreadTurnsListParams`): `threadId`, `cursor`, `limit`, `sortDirection` (default descending), and `itemsView` (`"notLoaded" | "summary" | "full"`, default summary).
- `thread/items/list` (`ThreadItemsListParams`): `threadId`, optional `turnId`, `cursor`, `limit`, `sortDirection` (default ascending).
- `ThreadResumeParams.excludeTurns` returns metadata only, and `ThreadResumeResponse` carries `turnsBackwardsCursor` and `itemsBackwardsCursor` for paging back from the resume point.
- `ThreadReadParams.includeTurns`' own docblock says full-history hydration "is deprecated for paginated threads".

## Measure first

With no turn, or with turns on `gpt-5.6-luna` only per `AGENTS.md`, and recorded in `docs/MANUAL_TESTING.md` with the CLI version:

- Which calls draw the notice: `thread/read` with `includeTurns`, `thread/resume` without `excludeTurns`, or both.
- Whether a thread `thread/start` creates today is `paginated`, and whether the home server's older rollouts read as `legacy`.
- Whether `thread/turns/list` and `thread/items/list` answer for a `legacy` thread, which decides whether one path serves both modes or the adapter branches on `historyMode`.

The home server's `~/.codex` was read-only in an earlier session's sandbox; OW-siboja made agentpane honour `CODEX_HOME`, so a temporary one under `/tmp` or the project tree works end to end.

## Load-bearing

- No call agentpane makes on a `paginated` thread draws the deprecation, and a `legacy` thread still loads.
- A reattached session repaints the same transcript it did before, and fork points name the same turns at the same indices -- the reducer's slot map (`CodexReducer.indexOfItem`) is what `listForkPoints` trusts, and that docblock says why.
- Transcripts are small today, so paging may fetch every page on a resume; whether agentpane ever loads only the recent end is a separate change, not this one.

## Done when

- Adapter tests driving a fake app-server with a `paginated` thread assert the adapter sends no `includeTurns: true` and no `thread/resume` without `excludeTurns`, and still produces the same transcript and fork points as before, red first.
- A `legacy` thread is covered the same way, by whichever path the measurement chose.
- A live reattach and a fork on the home server, driven through agentpane on `gpt-5.6-luna`, show no deprecation notice, recorded in `docs/MANUAL_TESTING.md` with the CLI version.
- `bun run check` passes.
