---
labels: [change, emacs]
closed: done
---

# Codex's four warning notifications reach both clients as a non-fatal notice, where the reducer drops them today

The owner decided on 2026-09-24 (OW-fomebu) that agentpane surfaces all four of Codex's warning notifications, as a notice distinct from the error banner, in the browser and in `agentpane-mode`.
Today `CodexReducer.handle` in `src/server/adapters/codex/reducer.ts` sends each of them to its `default` branch, which drops it without a trace, and Codex does not keep them either: across the home server's 119 rollouts on 2026-09-24, no warning or error event type was ever stored.
So nothing could reveal one after the fact, which is why the decision was to surface them rather than defer until one was seen.

This is one card for both clients, as `AGENTS.md`, "Both clients", allows: the capability lands in both or neither, and here it lands in both.

## The four notifications

From `resources/codex-protocol/ServerNotification.ts` and `v2/`, generated from an older `codex-cli` than the installed `0.156.0` (OW-riluye):

- `warning` (`v2/WarningNotification.ts`): `threadId: string | null`, `message`.
- `guardianWarning` (`v2/GuardianWarningNotification.ts`): `threadId: string`, `message`.
- `deprecationNotice` (`v2/DeprecationNoticeNotification.ts`): `summary`, `details: string | null`, no thread.
- `configWarning` (`v2/ConfigWarningNotification.ts`): `summary`, `details: string | null`, optional `path` and `range`, no thread.

The one observed live is a `warning` naming a thread, drawn by a `turn/start` on a model Codex had no metadata for: `docs/MANUAL_TESTING.md`, "What a Codex turn on a model that does not exist does" (OW-wawuzu, `codex-cli 0.156.0`).
A fixture or a hand-built notification in the reducer's tests is the vehicle; a live reproduction on a made-up model needs the owner's leave again, since OW-wawuzu's exception did not carry over.

## Where it goes

- The reducer: a new effect beside `{ type: "error" }` in `CodexEffect`, and the `default` branch's comment rewritten to say these four are surfaced and everything else there is not transcript state.
- The wire: a new arm beside `type: "error"` in the `ServerEvent` union in `src/shared/protocol.ts`, and its twin beside `session/error` in `src/emacs/protocol.ts` and `src/emacs/helper.ts`.
- The browser: the error banner is `view.error` in `src/client/session-state.ts`; the notice sits near it but is not it.
- Emacs: `session/error` becomes an `(:error MESSAGE)` node drawn with a leading ⚠ in the `agentpane-warning` face (`agentpane--upsert` and the node drawing in `emacs/agentpane.el`); the notice is its own node kind.

## Load-bearing

- A notice is not an error, so it rides neither `onError` nor the `error` event.
  `onError`'s contract is "a turn failed in a way the transcript does not convey", and the comment on the stderr handler in `src/server/adapters/pi/process.ts` records why that contract is guarded.
  Nothing about a notice clears or sets `view.error`, and the next prompt does not clear it the way it clears an error (OW-31).
- A thread-scoped notice reaches that thread's session only, and one with no thread is not dropped.
  A fork's borrower shares its parent's app-server connection (OW-lajehi, "CodexAdapter borrowed connection" in `src/server/adapters/codex/adapter.test.ts`), so say which sessions a thread-less notice reaches and why; D13 in `docs/DESIGN.md` plans a session-less `notice` arm on `ServerEvent` for server-global conditions, which is prior art to reuse or to reject with a reason.
- `details` and `path`, where present, are not thrown away.

## Incidental

Wording, placement, and whether a notice persists or can be dismissed.
It is a first cut, to be tuned once the owner has seen one.

## Done when

- A reducer test fed each of the four notifications asserts the new effect and no `error` effect, shown red first.
- A wire test in each of `src/server/http/` and `src/emacs/helper.test.ts` carries the notice through, shown red first.
- A client test in `src/client/` shows the notice drawn and `view.error` untouched, shown red first.
- An ERT test in `emacs/agentpane-test.el` shows the notice drawn as its own node, not as `(:error ...)`, shown red first, with the Commentary's test count in `emacs/agentpane.el` updated.
- `bun run check` and the whole ERT suite, run as the Commentary of `emacs/agentpane.el` gives it, both pass.

## Close note

Built: Codex's `warning`, `guardianWarning`, `deprecationNotice` and `configWarning` notifications now reach both clients as a non-fatal notice, separate from the error banner.
`CodexReducer` emits a `notice` effect carrying an `AgentNotice` (`kind`, `message`, `details`, `path`, defined in `src/shared/protocol.ts`).
For `configWarning`, the start of `range` is appended to `path` as `:LINE:COLUMN`.
`BackendAdapter` gains an optional `onNotice`, which only the Codex adapter implements.
`SessionManager` broadcasts it as a new per-session, sequenced `notice` arm on `ServerEvent`.
The browser keeps `view.notices` in a `role="status"` list beside the error banner.
The Emacs helper sends `session/notice` and repeats the session's notices on every `session/snapshot`.
`agentpane-mode` draws each notice as its own `(:notice ...)` node, marked ℹ, in a new `agentpane-notice` face.
Nothing about a notice sets or clears `view.error`, and the next prompt does not clear it.

Routing: a notice that names a thread reaches that thread's session only, through the reducer's existing cross-thread guard.
A notice with no thread reaches every session on the app-server that sent it, a fork's borrower included, because it is about that process; the reason is at `CodexAdapter.onNotice`.
D13's planned session-less `notice` arm was not reused, because these notices belong to specific sessions.
D13 now records that the `notice` tag is taken.

Review found that `agentpane-mode` wiped notices at the next snapshot, and a Codex turn boundary always sends one.
Carrying `notices` on the helper's `session/snapshot` fixed that.

Verified: every new test was shown red first, across the reducer, the adapter (including the borrower split), HTTP SSE, the helper wire, browser state, `App`, and two ERT tests.
The dispatching session re-broke the reducer and the render and saw 7 fail.
Final runs: `bun run check` reported 1299 tests passing and 0 svelte-check errors; ERT ran 88 tests, 88 as expected; `bun run test:browser` passed 22 of 22.

Left open: notices share OW-bipume's gap, since no server snapshot carries them, so a reconnect, a late attach, or a notice sent while `adapter.start` is awaited loses them.
OW-bipume was amended to say so.
A warning naming a D19 subagent thread reaches no session; that is filed as OW-weyefe.
The browser has no way to dismiss a notice and does not de-duplicate repeats: a first cut.
