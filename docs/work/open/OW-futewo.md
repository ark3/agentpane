---
labels: [defect]
blocked-by: [OW-fafeja]
---

# A spawned Codex child's blocking ServerRequest is published as a request for the parent session.

Found during the adversarial review of OW-fafeja.

`src/server/adapters/codex/reducer.ts` (`handle`) converts every `isCodexServerRequest` message into a request effect before the notification thread-scope guard runs.
`src/server/adapters/codex/adapter.ts` (`applyEffects`) registers that effect against `currentRef` and emits it to the browser as though the attached parent owned it.
The generated payloads `resources/codex-protocol/v2/CommandExecutionRequestApprovalParams.ts`, `FileChangeRequestApprovalParams.ts`, `PermissionsRequestApprovalParams.ts`, and `ToolRequestUserInputParams.ts` all carry `threadId`.

A spawned child that needs approval or user input can therefore interrupt the parent's UI with a request whose reply is routed on the shared connection but whose ownership is misrepresented.
The greeting capture in `resources/fixtures/codex/subagent.jsonl` has no server request, so it cannot settle the behavior by replay alone.

## Which way to fix it

Not by rejecting the request.
A `ServerRequest` is a JSON-RPC request the client on that connection must answer, and the parent adapter is the only client there: the child thread has no adapter of its own in agentpane.
Dropping it leaves the child blocked in its approval forever and the parent sitting in `wait` until that times out, with nothing on screen explaining either, which is worse than the mislabel.
Routing the reply through the parent's session is therefore correct, and the defect is presentation only.

The fix keeps the request pending and answerable and carries the child's identity on it, so the client can say the subagent is asking rather than implying the parent is.
`AgentRequest` in `src/shared/protocol.ts` has `session`, `kind` and `payload`; the request's own `threadId` is already inside `payload` for the four request kinds named above, so the smallest change is a field beside `session` that names the issuing thread when it is not the session's own, filled from that `threadId`.
The child's spawn prompt from the parent's `collabAgentToolCall` item (`prompt`, `receiverThreadIds`) can label it further if OW-benige has landed by then, and is not required.

OW-bijera is where a request first becomes answerable from the browser, and this card's field is what that UI reads to label it; land the two together or this one first.
OW-18 is still open on whether agentpane sets `approvalPolicy` at all, and a spawned child inherits the parent's policy, so under agentpane's default of `on-request` children do raise these.

Done when an adapter-level test emits a foreign-thread blocking request after attaching the parent, is watched red against the current code, and passes once the emitted `AgentRequest` names the child thread as its issuer while staying pending and replyable through the parent, while a same-thread request remains covered and names no foreign issuer, and `bun run check` passes.
