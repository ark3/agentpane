---
labels: [change, browser-testing]
---

# Pi's notify reaches neither client, though the per-session notice arm both clients draw could carry it

Filed 2026-10-14 from OW-nubafo, which the owner decided that day: every Pi `notify` becomes a notice; see `docs/DESIGN.md` D11, the paragraph "Pi's `notify` is a notice."

In service of a Pi extension command's answer reaching the user: for a prompt an extension command handles, one `notify` is the command's whole output (`docs/MANUAL_TESTING.md`, "A second Pi prompt sent before the first's `agent_start` is refused, and an extension command's is answered with nothing (OW-kokotu)", subsection "A prompt an extension command handles", `pi 1.2.0`), and today it reaches neither wire.

## What is there

`reducePiNotification` in `src/server/adapters/pi/reducer.ts`, its `extension_ui_request` case, returns `{ state }` for every method not in `PI_DIALOG_METHODS`, so `notify` is dropped with `setStatus`, `setWidget`, `setTitle` and `set_editor_text`.
The `notify` arm of `PiExtensionUiRequestEvent`, in the `PiNotification` union of `src/server/adapters/pi/protocol.ts`, carries `message` and an optional `notifyType` (`info`, `warning` or `error`; Pi's `docs/rpc-extension-ui.md` defaults it to `info`).
`PiAdapter` in `src/server/adapters/pi/process.ts` implements no `onNotice`, the optional method of `BackendAdapter` in `src/server/adapters/types.ts`.
Everything past the adapter exists: `SessionManager` in `src/server/http/session-manager.ts` subscribes `onNotice` before `start()` -- optionally, so an adapter without it sends nothing and nothing complains -- holds notices for every snapshot and drops one identical to a notice held (OW-piloni); the broadcaster sends the per-session `notice` event of `src/shared/protocol.ts`; the browser draws `.notices` in `src/client/App.svelte`; the Emacs helper forwards `session/notice` and `emacs/agentpane.el` draws it.
`CodexAdapter` and the `warning` and `configWarning` cases in `src/server/adapters/codex/reducer.ts` are the prior art for a reducer that yields a notice.

## The change

Pi's `notify` reaches `onNotice` as an `AgentNotice` whose `kind` is `"notify"`, the method's own name, as Codex's notices carry theirs; the other four fire-and-forget methods stay dropped.
Whether and how `notifyType` travels is the executor's: neither client distinguishes notices by level today, and `AgentNotice` gains no field for it.
Because the subscription precedes `start()`, a `notify` an extension sends at `session_start` — `auto-read-agents-refs.ts` on the home server sends `Auto-loaded N file(s) from @references in AGENTS.md` whenever it read at least one referenced file, and as of `pi 1.2.0` Pi writes it before reading agentpane's `get_state` — is covered by the same path; that is load-bearing, not incidental.

A `notify`'s `message` may span lines: `/refs` sends `Discovered @references:`, a blank line, then one line per reference.
`AgentNotice.message` is documented as "the one line to show", and the browser draws it in a `<span>` under `.notices li` in `src/client/app.css`, with no `white-space` rule, so its newlines collapse; `agentpane--pp` in `emacs/agentpane.el`, in its `:notice` branch, inserts it raw ahead of `details` and `path`, which it joins with a newline and two spaces, so there its lines likely already break, without that indent.
The executor decides how a multi-line `notify` is carried (in `message` whole, or split between `message` and `details`) and makes both clients show its lines as lines; any client change that takes lands here, in both clients, per AGENTS.md "Both clients".

The docblocks that say otherwise change with the code, four of them, some wrapped mid-claim: the comment in the reducer's `extension_ui_request` case ("no home in the frozen `ServerEvent` union", and its pointer to a workstream report that is not in the repo), `onNotice` in `src/server/adapters/types.ts` ("only the Codex adapter implements it"), `AgentNotice` in `src/shared/protocol.ts` (which names Codex's four notifications as the whole set, and "the one line to show" if that changes), and `session/notice` in `src/emacs/protocol.ts` ("Only the Codex adapter produces any", and its own "the line to show" if that changes).

## Done when

- A test in `src/server/adapters/pi/process.test.ts`, red first, emits a `notify` line and asserts its message reaches a listener on `adapter.onNotice`, so a reducer that yields a notice the adapter never exposes cannot pass it.
- A second, red first, subscribes `onNotice` before `start()` and emits the `notify` before `get_state` is answered, as an extension's `session_start` does; `startAdapter` in that file answers `get_state` itself, so this one needs that step apart.
- The existing tests "fire-and-forget methods (notify) do not produce a request or mutate state" in `reducer.test.ts` and "does not answer or name fire-and-forget presentation methods" in `process.test.ts` still hold for what they assert about requests and replies, and a `setStatus` still produces nothing.
- A multi-line `notify` is shown drawn as more than one line in each client: in the browser by a case in `e2e/banners.spec.ts`, which reaches notices only through `showBanners` in `e2e/harness.ts` and so needs a multi-line one there, since whether a `<span>` breaks at a newline is layout jsdom cannot see, and in Emacs by an `ert` test beside `agentpane-test-notice-lands-after-the-recorded-node` in `emacs/agentpane-test.el`, run by the command in that file's Commentary, since `bun run check` does not run it.
- None of the four docblocks named above still makes the claim quoted for it, read whole rather than grepped, since a claim wrapped across lines slips a grep.
- `bun run check` and `bun run test:browser` pass.
