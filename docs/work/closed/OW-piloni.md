---
labels: [change, emacs]
blocked-by: [OW-bipume]
closed: done
---

# A notice Codex repeats is shown again each time, in both clients

OW-tujiya surfaced Codex's warnings as notices and left de-duplication out as a first cut.
The first real notice, seen 2026-09-24, shows why it matters: the full-history deprecation that OW-kelene removes names no thread, so OW-tujiya's routing hands it to every session on that app-server, and the call that likely draws it, `thread/read` with `includeTurns: true` in `listForkPoints()` in `src/server/adapters/codex/adapter.ts`, runs on every fork and every fork-point listing.
So one condition becomes a growing list of identical notices.

## Where notices collect today

- Browser: `view.notices` in `src/client/session-state.ts`, appended on each `notice` event, and drawn by `App.svelte` as a `role="status"` list beside the error banner.
- Emacs: `session/notice` appends a `(:notice NOTICE)` node through `agentpane--upsert` in `emacs/agentpane.el`, and `agentpane--draw` redraws the session's notices on each snapshot, which the helper in `src/emacs/helper.ts` carries.
- Server: OW-bipume makes the server hold each session's notices so every snapshot carries them; that held list is the natural single place to de-duplicate, so both clients get it from one change, which is why this card waits on it.

## Load-bearing

- A notice identical to one the session already holds -- same kind, message, details and path -- is not shown a second time in either client.
- A different notice still appears, and nothing about de-duplication hides the first occurrence.

## Incidental

Whether a repeat is dropped silently or bumps a count or timestamp on the one shown, and whether the rule lives on the server or in each client.
It is a first cut, to be tuned from use; if it lives in the clients, `AGENTS.md`, "Both clients", asks for both in this card.

## Done when

- A test feeds the same notice twice and a different one once, and asserts two notices reach the clients, red first.
- An ERT test in `emacs/agentpane-test.el` shows the same in `agentpane-mode`, red first, with the Commentary's test count in `emacs/agentpane.el` updated, if the rule touches the Emacs side at all.
- `bun run check` and the whole ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, both pass.

## Close note

The server now de-duplicates notices, in the `onNotice` handler in `#start` in `src/server/http/session-manager.ts`.
A notice identical to one the session's container already holds, meaning the same kind, message, details and path, is neither held nor broadcast, so it is dropped silently.
Because both clients see only what the server sends and what snapshots carry, this one change fixes the browser and Emacs, and neither `emacs/` nor the client reducers changed.
The `ManagedSession` docblock now says so.

Verified with a new test in `src/server/http/session-manager.test.ts`, "holds and fans out a notice the adapter repeats only once (OW-piloni)".
It sends one notice twice and a different one once, then asserts that exactly two `notice` events went out and that a later snapshot holds those two.
It failed on the unchanged code, because the repeat was broadcast, and passes after the fix.
`bun run check` passed (1328 tests), and so did the full ERT suite (91/91).
No ERT test was added because the Emacs side was not touched.

Left as a first cut: once a notice is held, a repeat stays suppressed until the session closes, even if the condition recurs much later.
The check is per session, so a thread-less Codex notice still appears once in each session on that app-server.
