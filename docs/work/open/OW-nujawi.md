---
labels: [change]
---

# An unknown ServerRequest kind hangs the turn silently, which is the failure mode a backend upgrade will produce and nothing will report

This is D18's third group made concrete: the one class of backend fact this project defends against time, because its going stale opens a hole that no test and no log can notice.

`src/server/adapters/codex/adapter.ts` (`applyEffects`, the `"request"` case), `src/server/http/session-manager.ts` (`#pendingRequests`), `src/client/App.svelte` (the `selectedSession.requests.length > 0` block).

## The shape

A run on `codex-cli 0.154.0` showed no approval `ServerRequest` reaching agentpane under its own configuration (`docs/MANUAL_TESTING.md`, "Observed Codex approval policy, and what a fork carries"), and D7a now sets `approvalPolicy: "never"` besides.
On that basis nothing has been built to answer one: `App.svelte` renders `<p class="warning">Unsupported agent request pending.</p>` and the turn blocks until the session is killed, because D2a's contract is that an unanswered request hangs the agent.

The measurement is honest and the conclusion followed from it.
What makes it a hazard is that the absent code is exactly the code that would notice if it stopped being true.
When some later Codex raises a kind agentpane does not expect, there is no red test, no log line and no error -- the user experiences a session that stopped responding, which reads as flakiness and does not point here.

## What to build

Something small and loud, not the approval UI.
When a `ServerRequest` arrives whose kind agentpane has no handler for, answer it -- `DECLINE_RESPONSES` in `src/server/adapters/codex/protocol.ts` already holds per-kind decline shapes -- and surface an error naming the kind, so the turn fails in seconds with a message that identifies what arrived.

The point is that the turn stops hanging and the event announces itself.
A backend upgrade that reopens this then files its own bug report the first time it happens, instead of surfacing months later as intermittent trouble nobody can reproduce.

Declining rather than hanging is the right default *because* nothing should be arriving: under D7a an arriving request already means a premise broke, and a visible failure beats a silent stall. That reasoning is worth writing at the code, since it looks wrong to a reader who assumes requests are normal traffic.

## Its relationship to the cards around it

`OW-bijera` is the approval UI and stays open on its own terms; this card does not build it and does not close it.
Where they meet is that bijera's done-condition needs a live request to stage, which nothing can currently produce -- and this card makes the day that changes observable.
`OW-zogogo` asks whether any kind can arrive at all; whatever it answers, this card is worth having, because it is written against the kinds nobody predicted rather than the ones we could enumerate.
`OW-bovase` is the Claude side and is separately unreachable under `bypassPermissions`.

## Done when

A server-side test emits a `ServerRequest` of a kind the adapter has no handler for, watched red first, and asserts that the adapter answers it rather than leaving it pending and that an error naming the kind reaches the client.

The client no longer presents a pending request as a bare warning that never resolves; whatever it shows names the kind and does not imply the user can act on it.

A note at the decline site says arriving here means a D18 premise broke, so the next reader does not read the decline as rudeness to a legitimate request.
