---
labels: [change]
---

# An attached session can be renamed from agentpane, written through to the backend and kept nowhere else

`src/server/adapters/types.ts` (`BackendAdapter`), `src/server/adapters/pi/process.ts`, `src/server/adapters/claude/adapter.ts`, `src/server/adapters/codex/adapter.ts`, `src/server/http/app.ts` (the per-session switch), `src/shared/protocol.ts` (`SessionSummary`), `src/client/App.svelte`

The owner wants to name a session during the session, and decided on 2026-09-15 that the name goes to the backend and agentpane keeps no copy: `docs/DESIGN.md` D13, "Names are not marks, and this file does not hold them".
Read that paragraph for the why, and `docs/MANUAL_TESTING.md`, "All three backends rename an attached session over the wire", for the evidence that each backend accepts the rename mid-session.
Renaming a detached session is out of scope by the owner's decision, not by omission: there is no wire to write through, and the control is simply absent when the session is not attached.

## The three wire paths, all measured on 2026-09-15

- Pi (`pi 0.85.1`): the RPC command `{"type": "set_session_name", "name": ...}`, answered `success: true`; `get_state` reports `sessionName` afterwards.
  `src/server/adapters/pi/process.ts` `setModel` is the sibling to model this on, down to the typed command and response arms in `src/server/adapters/pi/protocol.ts`.
- Claude Code (`claude 2.1.270`): a `control_request` of subtype `rename_session` carrying `title`, answered with a success `control_response`.
  `sendControl({ subtype: "set_model", ... })` in `src/server/adapters/claude/adapter.ts` is the sibling.
  Do not send `/rename` as a user message: it works, but it runs as a turn, and the adapter already refuses input while a turn is active (OW-jihete).
- Codex (`codex-cli 0.154.0`): the request `thread/name/set` with `threadId` and `name`, answered `{}`, followed by a `thread/name/updated` notification carrying `threadName`.
  The vendored `resources/codex-protocol/v2/ThreadSetNameParams.ts` names the method wrongly; `thread/setName` is rejected with `-32600`.
  The params type is still right, so `import type` it and spell the method as the server does.

## What has to exist

- A `rename(name: string)` method on `BackendAdapter`, beside `setModel`, implemented in all three adapters.
- A route beside `case "model"` in the per-session switch of `src/server/http/app.ts`, taking `{ name }` and answering the way `model` does.
- `name: string | null` on `SessionSummary`.
  This card owns the field; the walk fills it with `null` here, and reading backend names into the list is other cards' work, which are blocked on this one for the field.
  An attached session's summary carries the name its adapter last set, and for Codex the name a `thread/name/updated` notification last reported, so the list shows the rename without a refetch of the store.
  It also carries a name the backend already had when the session was attached, where the adapter has that in hand at no extra cost: Pi's `get_state` round trip at start reports `sessionName`, and Codex's `thread/resume` response carries `thread.name`.
  Claude Code has no in-process read of its title, so a pre-existing Claude title waits for the card that reads store files; do not add a read here for it.
  Between this card and the two reader cards, a name therefore shows only while the session is attached, and a server restart drops it from the list until the session is attached again; that is expected, not a defect.
- A control in the client, present only while the session is attached and not mid-turn, per D14 reachable by pointer.
  The owner chose the Tools popover in `src/client/App.svelte` for it on 2026-09-15, beside New conversation and Compact, which are already gated on a selected session.
  What the item opens, an inline edit of the selected row or a prompt, is a first cut, and whichever it is has a visible way out (D14).

Load-bearing: write-through with no copy of agentpane's own, no control on a detached session, the Codex method spelling, and the Claude control request rather than the slash command.
Incidental: whether the rename is inline editing of the row or a prompt, and how an empty name is treated (Pi clears on empty and Codex accepts any string; pick one behaviour and say which in the close note).

## Done when

Each watched red first.

1. A test per adapter, against that adapter's fake in `test-support.ts`, asserts the exact command or request written for a rename and that the adapter's state carries the name after the response.
   For Codex, a second test feeds a `thread/name/updated` notification and asserts the state follows it.
   For Pi and Codex, a third test has the fake answer the attach-time `get_state` or `thread/resume` with a name and asserts the state carries it before any rename.
2. A route test asserts the rename endpoint refuses a session that is not attached and forwards to the adapter for one that is.
3. A client test asserts the Tools menu item is absent for a detached session and present for an attached one, and that a `SessionSummary` carrying a name renders it in place of the preview.

`bun run check` passes.
