---
labels: [defect]
---

# Nothing in the client can answer an agent's approval request, so a `ServerRequest` hangs the turn forever behind one line of text.

**Live backend run required.** Either backend settles this, and Codex is installed on the home server, so this needs no work-laptop trip; only Pi is confined there.

`src/client/api.ts`, `src/client/App.svelte`, `src/client/session-state.ts`

The server half is built and tested. `ROUTES.reply` (`src/shared/protocol.ts`)
addresses `POST /api/requests/:requestId`, `replyToRequest`
(`src/server/http/app.ts`) resolves it against `sessions.sessionOfRequest` and
hands the body to the adapter's `reply()` (`src/server/adapters/types.ts`), and
`src/server/http/app.test.ts` covers the round trip in "routes a request out
over SSE and the reply back to the right adapter".

The client half does not exist.
`src/client/api.ts` has no method that calls that route.
`App.svelte`'s entire response to a pending request is

```svelte
{#if selectedSession && selectedSession.requests.length > 0}
	<p class="warning">
		The agent is blocked on a request agentpane cannot answer: {...kinds}.
		There is nothing to act on here; end the session to clear it.
	</p>
```

OW-nujawi narrowed what reaches that block: as of that card, a Codex `ServerRequest` whose kind has no entry in `DECLINE_RESPONSES` is errored out at arrival and never becomes pending, so the only kinds that still land here are the three the adapter knows a decline shape for -- which are exactly the ones this card is about.

D2a's own words are that an unanswered request hangs the turn. Codex raises
one for `item/fileChange/requestApproval`; a real capture is in
`resources/fixtures/codex/tool-edit.jsonl`. So a turn that asks for approval
cannot be finished from agentpane at all -- only killed.

The client also never forgets a request once it arrives. `reduceServerEvent`'s
`request` case (`src/client/session-state.ts`) only appends, and the `snapshot`
case spreads the previous view, so the array survives a re-subscribe. Whether a
snapshot *should* clear it is `OW-1`, still open. Either way a reply needs its
own removal path: the server clears its own map after `adapter.reply()` and
emits nothing about it, so the browser is never told.

## Settle this before building it

Whether either backend raises approvals under agentpane's current
configuration is itself unsettled -- `OW-18` (whether to set `approvalPolicy`
on Codex threads, and whether that or the sandbox policy suppresses the
requests) and `OW-25` (whether Pi prompts when `trust.json` does not already
trust the workspace). If both are configured never to ask, this is unreachable
in practice and its priority changes. A live run answers it; reading will not.

The rendering shape is already stated rather than open: the docblock on
`AgentRequest` in `src/shared/protocol.ts` says `kind` is deliberately not
normalised because the renderer dispatches on it and falls back to a generic
prompt for unknown kinds, the same principle as D5's default tool card.

## Done looks like

A live run where a backend raises a real approval: the browser shows it with
its actual payload, approving lets the turn run to completion, declining ends
it cleanly, and in both cases the pending state clears. Evidence in
`docs/MANUAL_TESTING.md`.

Found on 2026-08-18 while checking `OW-diyuwu`, whose original premise was a
favicon badge for exactly this blocked state; that premise was dropped because
the state it reports can be entered but never left.

## What the OW-18 run means for this card (2026-09-11)

OW-18's conditional asked this card to become moot if nothing can arrive, or real but much smaller if only `item/tool/requestUserInput` can.
The run's answer fits neither, so both branches are discharged here and the remaining question is `OW-zogogo`.

Under agentpane's own Codex configuration no approval request arrives.
The adapter now sends `approvalPolicy: "never"` on all three thread-creation paths (D7a), and the live run (`docs/MANUAL_TESTING.md`, "Observed Codex approval policy, and what a fork carries") showed an edit-provoking prompt raising an `item/fileChange/requestApproval` on a `read-only` thread under `on-request` and none under `"never"` — and none at all on a `danger-full-access` thread, which is what agentpane uses, because the sandbox grants the write and `on-request` has nothing to ask about.
So the approval kind this card was written against, the one captured in `resources/fixtures/codex/tool-edit.jsonl`, is doubly out of reach: the sandbox leaves nothing to approve and the policy would suppress the ask anyway.

`item/tool/requestUserInput` was not settled.
Two deliberate attempts on a `"never"`, `danger-full-access` thread failed to provoke one: the model answered that the user-input tool is unavailable in the current mode, once with `experimentalApi: true` declared in `initialize` and once without, and neither turn emitted a tool call of any kind.
That is not evidence either way — the tool is gated by something those runs did not find.

The Claude side is separately unreachable: sbox injects `--permission-mode bypassPermissions` for the `claude` profile, so its `can_use_tool` control request cannot fire under agentpane's spawn (OW-bovase).
The Pi side remains OW-25.

What this leaves.
This card's premise is not refuted — an unanswered `ServerRequest` still hangs the turn behind one line of text, and the server half is still built and the client half still absent.
What changed is that no known request kind can currently reach it, so nobody can stage the live run this card's done-condition requires.
`OW-zogogo` carries that: it asks whether any `ServerRequest` kind can arrive under agentpane's own configuration at all, and its answer is what decides whether this card is moot, real, or merely unstageable.
