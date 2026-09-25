---
labels: [defect]
blocked-by: [OW-zisumi]
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

OW-nujawi narrowed what reaches that block: as of that card, a Codex `ServerRequest` whose kind has no entry in `DECLINE_RESPONSES` is errored out at arrival and never becomes pending, so the only kinds that still land here are the three the adapter knows a decline shape for.
OW-zisumi declines those three at arrival too, and D2a's paragraph "This is provisional" sequences it before this card, so once it lands nothing Codex sends is held here at all.
This card is then what makes holding right again for the kinds a human can answer, and it undoes that decline for them.

D2a's own words are that an unanswered request hangs the turn. Codex raises
one for `item/fileChange/requestApproval`; a real capture is in
`resources/fixtures/codex/tool-edit.jsonl`. So a turn that asks for approval
cannot be finished from agentpane at all -- only killed.

Amended 2026-09-24: since OW-bipume the server holds each session's pending requests, every snapshot carries them, and the client replaces its list from the snapshot (`src/client/session-state.ts`), so a reload shows what is still pending; OW-1 closed moot on that.
Between snapshots the `request` arm only appends; OW-gusifo adds the retraction that tells every client a request stopped being pending, one answered through the reply route included.

Emacs is in the same position as the browser.
The helper already forwards `requests/reply` to that route (`src/emacs/helper.ts`, OW-refibu), but nothing in `emacs/agentpane.el` sends it, and its request line says nothing in Emacs answers it yet.
Under `AGENTS.md`, "Both clients", answering lands in both clients here, or the Emacs half gets its own card, labelled `emacs` and blocked by this one.

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

## A constraint from OW-sewewe (2026-09-24)

OW-sewewe put `reply` in the per-session queue in `src/server/http/session-manager.ts` (`#serially`), behind `submit`, `fork`, `setModel`, `setEffort` and `compact`.
That is safe only while no queued verb waits on a request being answered, which held on 2026-09-24 because every adapter disposes of a request as it arrives: Pi cancels its dialogs (OW-yosuzo), Codex declines on publish, and Claude Code's `reply` does nothing.
Once a human can answer, a verb whose backend response waits on a dialog — a Pi `fork` or `compact` whose extension hook opens one — deadlocks with the reply queued behind it, until a close.
So whatever makes a request answerable also takes `reply` out of the queue, or shows by a test that no queued verb can wait on a request, and `#serially`'s docblock is amended to say which.
