---
labels: [change]
closed: done
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
When a `ServerRequest` arrives whose kind agentpane has no handler for, answer it and surface an error naming the kind, so the turn fails in seconds with a message that identifies what arrived.
`DECLINE_RESPONSES` in `src/server/adapters/codex/protocol.ts` holds per-kind decline shapes for the kinds already known, and an unknown kind by definition has no entry there, so the answer for it is a generic JSON-RPC error response rather than a table entry to add; the table is not the mechanism this card extends.

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

## Close note

Built as `a0b0419`, "fix: decline an unhandled Codex ServerRequest kind loudly (OW-nujawi)".

What landed.
In `applyEffects`' `case "request"` (`src/server/adapters/codex/adapter.ts`), a kind with no own entry in `DECLINE_RESPONSES` is answered at arrival with JSON-RPC `-32601` naming the method, and raises `emitError("codex sent an unsupported request (<kind>); agentpane declined it")`.
It never enters `pendingRequests` and is never published to `onRequest` listeners, so it cannot reach the client as a pending request at all.
`session-manager.ts` already wires `adapter.onError` to `broadcaster.error`, so the kind reaches the client as an error banner with no new plumbing.
A comment at the site says why: under D7a nothing should be arriving (no approval `ServerRequest` observed as of `codex-cli 0.154.0`), so reaching that line means a premise broke, and the alternative is D2a's silent stall.

The table was not extended, per the card: an unknown kind has no decline shape to add, and the answer for it is a generic error response.

Orphan the change created: with unknown kinds never pending, `reply()`'s `respondError(..., DECLINED_CODE, "declined by user")` fallback and the `DECLINED_CODE` constant became unreachable and were removed; `reply()` now responds `DECLINE_RESPONSES[pending.kind]` unconditionally and its docblock states the invariant that makes that safe.

Client: the bare `Unsupported agent request pending.` warning in `App.svelte` now names the kinds and says there is nothing to act on and that ending the session clears it. No approval UI was built; `OW-bijera` is untouched as work and stays open.

Verification.
New server test `src/server/adapters/codex/adapter.test.ts`, "answers a request kind it has no handler for and names it in an error (OW-nujawi)": emits `{ id: 31, method: "workspace/trust/request" }` and asserts the `-32601` response naming the method, that `onError` saw the kind, and that `onRequest` was not called.
Watched red first twice -- by the implementer before writing the adapter change, and again by the dispatching session, which reverted the guard to `if (false)` and saw `expected [] to deeply equal [ { id: 31, error: {...} } ]`; the empty response list is the hang itself.
`bun run check` green: 48 files, 1015 tests, tsc and svelte-check clean.

Review found one thing and it was fixed before landing: the guard was written `effect.kind in DECLINE_RESPONSES`, which is true for inherited keys (`toString`, `constructor`), so such a method would have been published as pending and later answered with a function -- and `reply()`'s new unconditional respond depends on that guard being exact. Changed to `Object.hasOwn`, already the idiom in `codex/jsonrpc.ts`.

Docs.
`docs/DESIGN.md` D18's third group now records that the runtime assertion exists for Codex requests and that the three approval kinds keep their pending path; D7a's quotation of the retired warning string was updated (the D7a decision itself is unchanged).
`docs/work/open/OW-bijera.md` quoted the retired markup and was amended in the same change, with a line saying only the three known kinds still reach that block.

Not done, deliberately: the "error reaches the client" assertion is at the adapter's `onError` edge, not end-to-end through `session-manager` to a socket; that broadcast wiring is pre-existing and covered elsewhere.
`bun run test:browser` was not run -- the client change is text inside an existing `<p class="warning">`, not layout, scrolling, the composer row or `public/`.
