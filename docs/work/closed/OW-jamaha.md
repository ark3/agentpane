---
labels: [change]
closed: done
---

# An attached session can be renamed over the HTTP API and the Emacs helper, written through to the backend and kept nowhere else

`src/server/adapters/types.ts` (`BackendAdapter`), `src/server/adapters/pi/process.ts`, `src/server/adapters/claude/adapter.ts`, `src/server/adapters/codex/adapter.ts`, `src/server/http/app.ts` (the per-session switch), `src/shared/protocol.ts` (`SessionSummary`), `src/emacs/protocol.ts` and `src/emacs/helper.ts` (`sessions/setModel` is the sibling)

The owner wants to name a session during the session, and decided on 2026-09-15 that the name goes to the backend and agentpane keeps no copy: `docs/DESIGN.md` D13, "Names are not marks, and this file does not hold them".
Read that paragraph for the why, and `docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire", for the evidence that each backend accepts the rename mid-session.
Renaming a detached session is out of scope by the owner's decision, not by omission: there is no wire to write through, and the control is simply absent when the session is not attached.

Rewritten 2026-10-01 under `docs/DESIGN.md` D27 (OW-fifaji): this card is the wire half only, both wires, per `AGENTS.md`, "Both clients".
The controls and the row label are OW-bumonu in the browser and OW-jidihu in agentpane-mode, each blocked by this card.

## The three wire paths, all measured on 2026-09-15

- Pi (`pi 0.85.1`): the RPC command `{"type": "set_session_name", "name": ...}`, answered `success: true`; `get_state` reports `sessionName` afterwards.
  `src/server/adapters/pi/process.ts` `setModel` is the sibling to model this on, down to the typed command and response arms in `src/server/adapters/pi/protocol.ts`.
- Claude Code (`claude 2.1.270`): a `control_request` of subtype `rename_session` carrying `title`, answered with a success `control_response`.
  `sendControl({ subtype: "set_model", ... })` in `src/server/adapters/claude/adapter.ts` is the sibling.
  Do not send `/rename` as a user message: it works, but it runs as a turn, and the adapter already refuses input while a turn is active (OW-jihete).
- Codex (`codex-cli 0.154.0`): the request `thread/name/set` with `threadId` and `name`, answered `{}`, followed by a `thread/name/updated` notification carrying `threadName`.
  `thread/setName` is rejected with `-32600`; the vendored `resources/codex-protocol/ClientRequest.ts` spells it `thread/name/set`, and `v2/ThreadSetNameParams.ts` is its params type, so `import type` that.

## What has to exist

- A `setName(name: string)` method on `BackendAdapter`, beside `setModel`, implemented in all three adapters.
  Not `rename`: in this code a rename is a ref change, as `onRefChanged`'s `cause` in `src/server/adapters/types.ts` says.
- A route beside `case "model"` in the per-session switch of `src/server/http/app.ts`, taking `{ name }` and answering the way `model` does, and `setName` beside `setModel` on the API in `src/client/api.ts`, which the Emacs helper calls too (`createAgentpaneApi` in `src/emacs/helper.ts`).
- `name: string | null` on `SessionSummary`.
  This card owns the field; the walk fills it with `null` here, and reading backend names into the list is other cards' work, which are blocked on this one for the field.
  An attached session's summary carries the name its adapter last set, and for Codex the name a `thread/name/updated` notification last reported, and the manager sends `sessions-changed` after either, as it does at a turn's end, so both clients re-list and show the name without a refetch of the store.
  It also carries a name the backend already had when the session was attached, where the adapter has that in hand at no extra cost: Pi's `get_state` round trip at start reports `sessionName`, and Codex's `thread/resume` response carries `thread.name`.
  Claude Code has no in-process read of its title, so a pre-existing Claude title waits for the card that reads store files; do not add a read here for it.
  Between this card and the two reader cards, a name therefore shows only while the session is attached, and a server restart drops it from the list until the session is attached again; that is expected, not a defect.
- `sessions/setName` on the Emacs helper's JSON-RPC, beside `sessions/setModel` in `src/emacs/protocol.ts` and `src/emacs/helper.ts`, forwarding to the route.
  That changes the contract the `src/emacs/protocol.ts` docblock declares frozen, so the docblock records the raising.
  `name` reaches agentpane-mode through `SessionSummary`, which the helper's `sessions/list` already returns as the shared type; that docblock's `sessions/list` entry lists the summary's fields, and gains `name`.

Load-bearing: write-through with no copy of agentpane's own, a rename refused for a detached session, the Codex method spelling, and the Claude control request rather than the slash command.
Incidental: how an empty name is treated (Pi clears on empty and Codex accepts any string; pick one behaviour and say which in the close note).

## Done when

Each watched red first.

1. A test per adapter, against that adapter's fake (`test-support.ts` for Claude Code and Codex; Pi's lives in `src/server/adapters/pi/process.test.ts`), asserts the exact command or request written for a rename and that the adapter's state carries the name after the response.
   For Codex, a second test feeds a `thread/name/updated` notification and asserts the state follows it.
   For Pi and Codex, a third test has the fake answer the attach-time `get_state` or `thread/resume` with a name and asserts the state carries it before any rename.
2. A route test asserts the rename endpoint refuses a session that is not attached, and forwards to the adapter for one that is and then broadcasts `sessions-changed`.
3. A test in `src/emacs/helper.test.ts` asserts `sessions/setName` forwards the session and name to the route.

`bun run check` passes.

## Close note

Landed 2026-10-01 in two commits on main: "sessions: name an attached session over the HTTP API and the Emacs helper, written through to the backend (OW-jamaha)" and the review follow-up "sessions: store a name as Pi does, and list an attached session's adapter name as is (OW-jamaha)".

Built: `setName` on `BackendAdapter` and all three adapters (Pi `set_session_name`, Claude Code `rename_session` control request with `title`, Codex `thread/name/set` plus `thread/name/updated` filtered to its own thread); `AdapterState.name`, read at attach from Pi's `get_state` `sessionName` and Codex's start/resume `thread.name`, and for Pi again after a fork; `POST /api/sessions/:backend/:id/name` (`ROUTES.name`, `SetNameRequest`) answering 204, 409 `not_attached` for a detached session, 400 `bad_request` for a blank name; `SessionSummary.name`, `null` from the walk and the adapter's name when attached; `sessions-changed` when an adapter's name changes; `setName` on `AgentpaneApi` and `sessions/setName` on the Emacs helper. The frozen headers of `src/server/adapters/types.ts`, `src/shared/protocol.ts` and `src/emacs/protocol.ts` record the raising under D27. No UI: OW-bumonu and OW-jidihu.

Empty and odd names: one rule for all three backends, Pi's as of `pi 1.0.0` read at the source -- line breaks become one space, the name is trimmed, and one empty after that is refused 400 at the route. Pi applies exactly that (`rpc-mode.js` trims and refuses empty, `appendSessionInfo` collapses `[\r\n]+`), so the listed name equals what Pi stores; "Pi clears on empty" describes Pi's file reader, not its RPC.

Verified: each done-condition test watched red by removing the code it covers -- per-adapter command and state tests, Codex notification test (own thread and other thread), Pi and Codex attach-time name tests, route refusal for a detached session, route forward plus `sessions-changed` plus listing, Emacs helper forward; the newline collapse watched red with the route's old trim. `bun run check` green, 1626 tests, 36s. No live CLI run.

Review dropped a fallback that kept the walk's name when an attached adapter reports `null`: nothing could reach it before names are read from stores, so the choice moved to OW-yilene ("The attached overlay"). Filed from review: OW-kametu (rename before the first turn or mid-turn never measured for Claude and Codex), OW-husuju (Pi's `session_info_changed` unread), OW-mepivi (Codex name read at `thread/start` and borrowed fork untested).
