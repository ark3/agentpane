---
labels: [change]
blocked-by: [OW-gusifo]
---

# A Codex request agentpane cannot answer is held until the session is killed, where D2a decided it is declined

Split from OW-gusifo on 2026-09-24, which now builds the retraction this card needs.

D2a in `docs/DESIGN.md`, the paragraph "And when the browser cannot answer either, the adapter declines rather than holding it" (decided 2026-09-11 on OW-yikoyo), is written in the present tense and is not yet true.
The `"request"` case of `applyEffects` in `src/server/adapters/codex/adapter.ts` publishes every kind that has an entry in `DECLINE_RESPONSES` (`src/server/adapters/codex/protocol.ts`) and holds it for a reply no client can send: the browser has no way to answer (OW-bijera), and nothing in `emacs/agentpane.el` sends the helper's `requests/reply`.
Kinds with no entry are already answered with an error at arrival and never published (OW-nujawi; the test "answers a request kind it has no handler for and names it in an error (OW-nujawi)").

`DECLINE_RESPONSES` covers `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and `mcpServer/elicitation/request`, which is not an approval.
The other kinds in `resources/codex-protocol/ServerRequest.ts` stay on OW-nujawi's path; whether `item/permissions/requestApproval`, `applyPatchApproval` or `execCommandApproval` should get decline shapes of their own is outside this card.
Under D7a's `approvalPolicy: "never"` no approval has been provoked live except `item/fileChange/requestApproval` on a `read-only` thread under `on-request` (OW-18, in D2a), so this card is driven by fakes.

## Shape

Publish the request as now, then decline it through the adapter's own `reply(externalId, null)` -- the path a user's "no" takes -- and let OW-gusifo's retraction clear it.
Declining before publishing would leave the request namespace per adapter lifetime, the typed reverse mapping for pre-adoption requests, wire-id scoping across sessions, numeric-versus-string wire ids and OW-futewo's `issuerThreadId` exercised by nothing, and OW-bijera needs all of them once a human can answer, when D2a's paragraph "This is provisional" says holding becomes right again.
Going through `reply` keeps them on the live path.

D2a rules out one outcome: "silently refusing on the agent's behalf".
So the user is told what arrived, by an error naming the kind as OW-nujawi's does (`emitError`); that error reaches Emacs as the session error OW-bipume carries on every snapshot, so this card has no Emacs work.
The browser's "end the session to clear it" warning in `src/client/App.svelte` must not stand after the exchange.

## The tests this moves

These tests in `src/server/adapters/codex/adapter.test.ts` assume a published request is still pending when the test replies, and after this change the adapter has already answered it:

- "scopes equal wire request ids to their adapter sessions"
- "distinguishes numeric and string wire request ids"
- "correlates replies to the original numeric request id"
- "identifies a child-thread blocking request and routes it through the parent (OW-futewo)"
- "does not set issuerThreadId for a same-thread blocking request (OW-futewo)"
- "publishes a blocking request once across both adapters, and answers it once"

"resolves a pre-adoption request through its typed reverse mapping" expects no response written.
"declines approvals with their protocol response shape" and "declines MCP elicitations with their generated protocol response shape" would stay green by accident, since the arrival decline becomes the last write.
Each is rewritten so it still covers the logic its name claims; if one cannot be, say which and why in the close note, because that is coverage removed rather than moved.

## Done when

- A test in `adapter.test.ts` has a kind with a `DECLINE_RESPONSES` entry arrive and asserts it is answered with its decline shape through `reply` under the id it was published with, an error naming the kind is emitted, and the request is retracted; red first, since today it is held.
- A test in `src/server/http/session-manager.test.ts` asserts the next snapshot after such an arrival carries no pending request and does carry the error.
- The tests listed above are rewritten as that section says.
- D2a's paragraphs "And when the browser cannot answer either" and "This is provisional" read true of the code.
- `bun run check` passes.
