---
labels: [change]
---

# Surface Claude Code's `can_use_tool` control request as an `AgentRequest`, replacing the Claude adapter's inert `onRequest`.

`src/server/adapters/claude/adapter.ts` `onRequest`/`reply`

Filed at OW-beripo's close (2026-08-25), against a shape already captured, per
that item's deferral: today the adapter never sees a permission ask because
sbox's claude profile injects `--permission-mode bypassPermissions` and the
jail is the confinement boundary (rationale in `adapter.ts`'s module doc —
read it before proposing to change the spawn default).

The recorded shape (OW-yilabe, fixture
`resources/fixtures/claude/permission-request.jsonl`, claude 2.1.238): the ask
only appears if the CLI is spawned with the undocumented
`--permission-prompt-tool stdio`; it is a CLI-initiated `control_request`
subtype `can_use_tool` (tool_name, full `input` including Edit's
`old_string`/`new_string`, `permission_suggestions`, `tool_use_id`), answered
by a `control_response` whose inner response is
`{behavior: "allow", updatedInput}`.

Open questions this item settles before coding: whether the spawn opts into
`--permission-prompt-tool stdio` always or per-session, and how a deny is
shaped (the fixture captures an allow). OW-bijera is the client half of the
`AgentRequest` story; this item is the Claude server half only.

Done when: adapter tests over the fixture drive `onRequest` → `reply` round
trips and fail before the change; `bun run check` green.
