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

## Probably a decline -- do not start this without reading OW-18

The owner decided on 2026-09-11 that agentpane avoids permission prompts rather than routing them into its UI, which is this card's whole premise.
Note also that `onRequest` is inert on this adapter for a structural reason, not an oversight: sbox injects `--permission-mode bypassPermissions` for the `claude` profile, and agentpane spawns its backends through sbox (D7), so the control request this card wants to surface cannot fire under agentpane's own spawn configuration.
See the `CodexAdapter`-side module docblock's counterpart at the top of `src/server/adapters/claude/adapter.ts`, which already says so.

Left open rather than closed only so the decline can cite the `docs/DESIGN.md` decision OW-18 records, instead of a conversation that does not outlive the session.
**That decision now exists**: `docs/DESIGN.md` D7a, "Codex approval policy: `never`, set by the adapter", recorded at OW-18's close on 2026-09-11.
It is written over Codex, but its reasoning is the general one this card's decline rests on — prompts are to be avoided rather than surfaced, and the trade is no dialog against a turn that hangs behind one line of text.
The decline note has something durable to cite whenever the owner chooses to write it.
Pulled off `now` on 2026-09-11 for the same reason it is likely declined.
