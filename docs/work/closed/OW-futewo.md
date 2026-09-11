---
labels: [defect, now]
blocked-by: [OW-fafeja]
closed: done
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
**Corrected 2026-09-11 by OW-18**: agentpane no longer has an `on-request` default.
The adapter sends `approvalPolicy: "never"` on all three thread-creation paths (`docs/DESIGN.md` D7a), and the live run raised no approval request at all on a `danger-full-access` thread under either policy.
A child does inherit the parent's `approvalPolicy` — that much the fork cells confirmed — but what it inherits is now `"never"`, so the sentence above has the mechanism right and the conclusion backwards.
Whether any `ServerRequest` kind can still reach agentpane is `OW-zogogo`.

Done when an adapter-level test emits a foreign-thread blocking request after attaching the parent, is watched red against the current code, and passes once the emitted `AgentRequest` names the child thread as its issuer while staying pending and replyable through the parent, while a same-thread request remains covered and names no foreign issuer, and `bun run check` passes.

## Close note

Added `issuerThreadId?: string | null` to `AgentRequest` (`src/shared/protocol.ts`) and to the reducer's `CodexEffect` "request" variant (`src/server/adapters/codex/reducer.ts`).
`CodexReducer.handle` now compares a `ServerRequest`'s own `threadId` (read out of `payload` via a new private `extractIssuerThreadId`) against the reducer's own `this.threadId`, and sets the effect's `issuerThreadId` only when they differ.
`CodexAdapter.applyEffects` (`src/server/adapters/codex/adapter.ts`) copies that onto the `AgentRequest` it emits, only when non-null, so a same-thread request is unchanged and a foreign-thread request now names its issuing thread while still being routed, held pending, and replied through the parent adapter -- the parent stays the only client on the connection, per the card's "which way to fix it".

Verified: `reducer.test.ts` gained three cases (child-thread sets `issuerThreadId`, same-thread sets none, a request with no `threadId` in its payload sets none), and `adapter.test.ts` gained two adapter-level cases exercising the full path -- `proc.emit` a foreign-thread `ServerRequest` after `startedAdapter`, assert the emitted `AgentRequest.issuerThreadId` and `session.id`, then `adapter.reply(...)` and assert the process receives the JSON-RPC response, so "stays pending and replyable through the parent" is covered end to end, not just at the pure reducer. Both new suites were watched red against the pre-fix code before going green. `bun run check`: 48 files, 1012 tests, clean.

Commits on main: 17816f0 (fix), 2e452e2 (adapter-level test, added after review found the first pass only covered the reducer, not `applyEffects`).

OW-bijera (browser-side rendering of this field) and OW-18 (whether agentpane sets `approvalPolicy`) are unaffected and remain open; this card only made the field available to emit.
