---
labels: [change, sweep-0929]
---

# Remove agentpane's agent-request pipeline, keeping only the refusal at arrival and its error line, now that D2a is final: no approvals and no questions

Decided by the owner on 2026-09-29, in the conversation that filed the `sweep-0929` cards.
This card was first filed that day as the question of whether D2a should become final; it is now the change that records the answer and carries it out.

## The decision

agentpane never holds an agent request.
That covers approvals, which D7a already avoids by configuration, and questions: Codex `item/tool/requestUserInput` and MCP elicitation, Pi's `select`, `confirm`, `input` and `editor` dialogs, and Claude Code's `can_use_tool` should it ever arrive.
Each adapter refuses a request the moment it arrives — declined where the kind has a decline shape, cancelled for a Pi dialog, errored out otherwise — and posts a session error naming the kind, exactly as it does today.

Why: since OW-zisumi and OW-yosuzo every request is already refused within the tick it arrives in, so the holding machinery runs on every request and never waits; the owner never meets a question in practice; and what questions would really cost, a way to answer each kind in both clients under the Both clients rule, was never built.
D25 already constrains any future holding too: a lost connection detaches every session, so a held request could not outlive a disconnect.

How final: exactly as final as usage justifies.
The error line posted at arrival is the tripwire — "codex sent a request agentpane cannot answer yet (…); agentpane declined it" and its Pi twin — and it survives this card.
Those lines appearing in the owner's own use is the named condition for reopening D2a; git history and D2a's current text hold the machinery and its reasoning if that day comes.

## What goes

The pipeline that exists only so a request could wait for a human:
- the adapter contract's `onRequest`, `onRequestResolved` and `reply` in `src/server/adapters/types.ts`, and `AgentRequest` with them;
- Codex's `pendingRequests`, `externalRequestIds` and request namespacing in `src/server/adapters/codex/adapter.ts`, and the `request-resolved` effect handling; `DECLINE_RESPONSES` stays, since the refusal at arrival needs it;
- Pi's `pendingUiRequests` and the request path through `src/server/adapters/pi/reducer.ts` and `process.ts`; the cancel at arrival stays;
- Claude Code's inert `onRequest` and `reply` in `src/server/adapters/claude/adapter.ts`;
- `SessionManager`'s `#pendingRequests`, `ManagedSession.requests`, `clearRequest`, `reply`, the fork's re-owning of its parent's requests and `close()`'s request cleanup, in `src/server/http/session-manager.ts`, plus `reply`'s entry in the `#serially` docblock;
- the reply route (`replyToRequest`) in `src/server/http/app.ts`, and the client's call to it in `src/client/api.ts`;
- the `request` and `request-resolved` events and every snapshot's `requests` field in `src/shared/protocol.ts`, and their counterparts in the Emacs contract `src/emacs/protocol.ts` (raise it in that file's FROZEN INTERFACE docblock, as its seventh raising or whichever number it has reached), `src/emacs/helper.ts`, and `agentpane--draw`'s REQUESTS in `emacs/agentpane.el`;
- `requests` in `src/client/session-state.ts` and whatever the browser draws for a pending request, with the pending-request banner in `e2e/harness.ts`;
- the fakes in `src/server/http/testing/fakes.ts`, and the tests that assert the pipeline, in `codex/adapter.test.ts`, `pi/process.test.ts`, `session-manager.test.ts`, `app.test.ts`, `controller.test.ts`, `App.test.ts`, `session-state.test.ts`, `helper.test.ts` and `emacs/agentpane-test.el`.
`agentpane--requests-out` in `emacs/agentpane.el` is unrelated — it tracks JSON-RPC requests to the helper — and stays.

This is a grep-led list, not a read of every hit; the implementer confirms each at the source.
Both clients change in the same card, since the wire field goes from both at once.

## What stays

The refusal at arrival and its error line, in each adapter, with a test per adapter that a request arriving is answered with the refusal on the wire and produces the session error naming its kind.
Codex's error-out for a kind with no decline shape (the `UNSUPPORTED_REQUEST_CODE` path) stays as it is.
Both messages say agentpane "cannot answer yet"; drop the "yet", which promised the holding this card retires, and keep each naming the kind.

## Docs and probes

- D2a in `docs/DESIGN.md` is rewritten to the decision above, replacing its "This is provisional" paragraph and the paragraph about keeping the machinery for OW-bijera, and naming the tripwire as the condition for reopening.
- D12's exemption 2, "Never evict a session blocked on a pending request", goes, and the exemption list is renumbered with any references to it.
- D7a's sentence that an approval is "named in a session error (D2a)" stays true; check it reads so.
- `resources/probes/agentpane_pi_smoke.py`'s `requests_in` observes the `request` events this removes; make the probe observe the error line instead, and say in `docs/MANUAL_TESTING.md` at its next run that it changed.
- `docs/HANDOFF.md` and older `docs/MANUAL_TESTING.md` sections describe the pipeline as history; leave history alone, but retire any sentence that states it as current fact, per the AGENTS.md rule on retiring every copy.

## The cards this settles

On closing this card: OW-bijera, OW-bovase and OW-zogogo close `--declined`, and OW-siguzo, OW-nobeko and OW-johano close `--moot`, each note citing this card.
OW-25 is amended: with approvals refused at arrival, what is left is whether the sandboxed path's `trust.json` copy is still needed, or close it if nothing is.

## Done when

- `rg -n 'AgentRequest|onRequestResolved|pendingUiRequests|pendingRequests|request-resolved' src emacs e2e` finds nothing.
- The per-adapter refusal tests above exist and pass, each seen red first by breaking the refusal.
- `bun run check` passes, and `bun run test:browser` too, since the browser's pending-request drawing and `e2e/harness.ts` change.
- The ERT suite passes, run as `emacs/agentpane.el`'s Commentary says, with the pass count there updated.
- D2a and D12 read as above.
