---
kind: defect
where: '`src/client/api.ts`, `src/client/App.svelte`, `src/client/session-state.ts`'
---

# Nothing in the client can answer an agent's approval request, so a `ServerRequest` hangs the turn forever behind one line of text.

**Work laptop:** needs a live Pi or Codex run.

The server half is built and tested. `ROUTES.reply` (`src/shared/protocol.ts`)
addresses `POST /api/requests/:requestId`, `replyToRequest`
(`src/server/http/app.ts`) resolves it against `sessions.sessionOfRequest` and
hands the body to the adapter's `reply()` (`src/server/adapters/types.ts`), and
`src/server/http/app.test.ts` covers the round trip in "routes a request out
over SSE and the reply back to the right adapter".

The client half does not exist. `src/client/api.ts` has no method that calls
that route. `App.svelte`'s entire response to a pending request is

```svelte
{#if selectedSession && selectedSession.requests.length > 0}
	<p class="warning">Unsupported agent request pending.</p>
```

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
