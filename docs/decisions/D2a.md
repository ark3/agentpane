# D2a. Server-initiated requests

Codex's `ServerRequest` (`resources/codex-protocol/ServerRequest.ts`) is a request *from* the agent *to* the client, carrying a `RequestId`: approval requests, `item/tool/requestUserInput`, MCP elicitation, dynamic tool call.
The agent blocks until answered.

**agentpane never holds an agent request: every adapter refuses one the moment it arrives, and names it in a session error; Claude Code sends none under the flags agentpane spawns it with (below).**
Decided by the owner on 2026-09-29 (OW-letevu), making final what OW-yikoyo decided provisionally on 2026-09-11.
It covers approvals, which D7a already avoids by configuration, and questions: Codex's `item/tool/requestUserInput` and MCP elicitation, Pi's `select`, `confirm`, `input` and `editor` dialogs, and Claude Code's `can_use_tool` should it ever arrive.

Why refuse rather than hold, as OW-yikoyo put it: a request nothing could answer was being held until the user killed the session, and the user was told that killing it was the remedy.
A turn that carries on from a "no" it can read beats a session that has to be destroyed, and the model can try something else -- which is the case for declining rather than erroring where a decline shape exists, since a JSON-RPC error reads as a broken client rather than a refusal.
The user is told what arrived in both cases; silently refusing on the agent's behalf is the one outcome ruled out.

Why final rather than provisional: since OW-zisumi and OW-yosuzo every request was already refused within the tick it arrived in, so the machinery that published, held and retracted requests ran on every one and never waited; the owner never meets a question in practice; and what questions would really cost, a way to answer each kind in both clients under the Both clients rule in `AGENTS.md`, was never built (OW-bijera).
D25 constrains any future holding too: a lost connection detaches every session, so a held request could not outlive a disconnect.
OW-letevu removed that machinery -- the adapter contract's `onRequest`, `onRequestResolved` and `reply`, the server's pending-request table and reply route, the `request` and `request-resolved` events and every snapshot's `requests`, and their counterparts on the Emacs helper's wire and in both clients.

How each adapter refuses:

- **Codex.**
  A kind with an entry in `DECLINE_RESPONSES` (`src/server/adapters/codex/protocol.ts`) is answered with that decline shape and named in the error "codex sent a request agentpane cannot answer (KIND); agentpane declined it" (OW-zisumi).
  A kind with no entry is errored out with JSON-RPC `-32601` and named in "codex sent an unsupported request (KIND); agentpane declined it" (OW-nujawi).
- **Pi.**
  An `extension_ui_request` carrying one of `PI_DIALOG_METHODS` (`src/server/adapters/pi/protocol.ts`) is answered with an `extension_ui_response` carrying `cancelled: true`, the one refusal Pi's dialogs have, and named in "Pi sent a dialog agentpane cannot answer (METHOD); agentpane cancelled it" (OW-yosuzo).
  Pi's fire-and-forget methods expect no reply, so nothing refuses them.
- **Claude Code.**
  No `control_request` should arrive: the `can_use_tool` ask exists only under the undocumented `--permission-prompt-tool stdio`, which the adapter does not pass (its module docblock in `src/server/adapters/claude/adapter.ts`).
  One that arrives anyway is refused by `refuseControlRequest` in that file (OW-kihubu).
  A `can_use_tool` is answered with a success `control_response` carrying `behavior: "deny"` and named in "claude sent a request agentpane cannot answer (can_use_tool); agentpane declined it".
  Any other subtype is answered with an error `control_response`, the shape the CLI uses to error a request agentpane sent, and named in "claude sent an unsupported request (SUBTYPE); agentpane declined it".
  As of `claude 2.1.283` each reply, answering a `can_use_tool`, reached the model as an `is_error` tool result and the turn went on to its `result` (`docs/MANUAL_TESTING.md`, OW-kihubu); no other subtype could be provoked, so the error reply is measured on `can_use_tool` alone.

**The error line is the tripwire, and what reopens this.**
This is exactly as final as usage justifies.
Any of the five error lines above appearing in the owner's own use is the named condition for reopening D2a; git history and this decision's text before OW-letevu hold the machinery and its reasoning if that day comes.

**These requests are real, not theoretical.**
The `tool-edit` fixture in `resources/fixtures/codex/` contains a live `item/fileChange/requestApproval`, answered by the capture harness, followed by `serverRequest/resolved`.
An unanswered one hangs the turn.

What the OW-18 run showed (`docs/MANUAL_TESTING.md`): a live edit-provoking prompt on a `danger-full-access` thread raised no approval `ServerRequest` under either `on-request` or `never`, and the same prompt on a `read-only` thread raised one `item/fileChange/requestApproval` under `on-request` and none under `never`.
So `approvalPolicy: "never"` demonstrably suppresses that request where one would otherwise arise, and on a `danger-full-access` thread none arises to suppress — the sandbox grants the write and `on-request` has nothing to ask about.
Those are different facts, and only the `read-only` pair is a suppression result.
`item/fileChange/requestApproval` is the only approval kind any cell provoked; the command-execution and permissions approvals were not measured.
Note the older framing here — that sbox's injected `--sandbox danger-full-access` governs this — was wrong: that CLI flag is a no-op for `app-server` (OW-37), and the effective levers are the per-thread sandbox and approval policies, both of which the adapter now sets (D7a).
`requestUserInput` and MCP elicitation are separate from the approvals and have not been shown to be suppressed by either lever; the attempts to provoke a `requestUserInput` are recorded with the OW-18 run and did not fire, and one that does is refused at arrival like any other request (above).
