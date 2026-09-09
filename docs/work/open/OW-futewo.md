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

Done when an adapter-level test emits a foreign-thread blocking request after attaching the parent, is watched red against the current code, and passes after the request is rejected without an `AgentRequest` or pending-request entry, while a same-thread request remains covered and `bun run check` passes.
