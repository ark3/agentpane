---
labels: [change, d25]
closed: done
---

# The prompt, fork, fork-points, model and effort routes attach first, so a request that races a close spawns the session again; only the attach route should start an agent

Filed 2026-09-28 under D25 in `docs/DESIGN.md`, which the owner took that day; read D25 first, since this card is its first rule.

## What happens

`sessionAction` in `src/server/http/app.ts` attaches before it acts on five routes: `prompt` (`if (!sessions.isAttached(ref)) await sessions.attach(ref)`), `fork`, `fork-points`, `model` and `effort` (`await sessions.attach(ref)`).
`SessionManager.attach` in `src/server/http/session-manager.ts` finds a ref being closed in `#disposing`, awaits the disposal, and then spawns a fresh adapter.
So a request that reaches the server after a close has begun, from any client, starts the session the user just closed, with nothing holding it.
That one mechanism is the whole premise of OW-wovamo (a setModel or setEffort in flight across `agentpane-close-session`), OW-ripahi (the browser's Send, Fork and Compact during a Detach) and the prompt that races a close which D21 and D24 both list as still open; those cards closed moot into this one.

## The change

Those five routes act on a session that is already attached, or refuse; only the `GET` of `ROUTES.session` spawns.
`compact`, `abort` and `reply` already behave this way: `compact` through `SessionManager.#serially`, which throws `UnknownSessionError` for a container with no adapter, `abort` through `requireAttached`, and `reply` with a 409 `not_attached`.
Which status the refusal carries is this card's choice; what is load-bearing is that nothing is spawned, and that the refusal is one a client can tell apart from a failed turn, as `not_attached` is.
`close()` takes the container out of the table synchronously, before its first await, so once the attach calls are gone a request arriving after a close has begun misses `#lookup` and is refused with no further guard; do not add one.
`attach` keeps its `#disposing` wait: an explicit attach after a close must still wait out the disposal before it spawns.

Both clients already attach explicitly on every deliberate path, which D25 records as read on 2026-09-28 and this card is to confirm: the browser's `create` and `select` in `src/client/controller.ts` call `api.attach` before anything else reaches the session, and agentpane-mode's `agentpane-new-session` and its send from an unattached buffer (`agentpane--attached-then` in `emacs/agentpane.el`) send `sessions/attach` first.
If either client turns out to lean on a route's attach for a deliberate path, that path attaches explicitly first as part of this card, in that client.

## Every copy of the old behaviour goes in the same change

Grep `attaches first`, `attach first` and `attaching if needed`; as of this filing they stand in the fork comment in `src/server/http/app.ts` ("Attach first so the session has a live adapter"), the `submit` comment in `session-manager.ts` ("a caller that attaches first"), and in `emacs/agentpane.el`: the `agentpane--spawn-timeout` docstring, which lists the routes that may spawn, and the docstrings of `agentpane--closing` and `agentpane--fork-point`, which justify refusing during a close by the route attaching first.
The `agentpane--closing` refusals themselves may stay: they now spare the user a refused request rather than a respawn, and the docstrings say that instead.
The prompt route's comment on reading `priorError` before the attach names a case that no longer exists, and goes too; `priorErrorId` itself stays (OW-jokoto).
Emacs lines that say the *client* attaches first, such as `agentpane-fork` on a previewed transcript, are true and stay.

## Done when

A test in `src/server/http/app.test.ts` for each of the five routes, red first, sends it for a session that is not attached and asserts the refusal and that the adapter factory started nothing.
A test there closes an attached session with its disposal held, sends a `prompt` and a `model` for it while the close is out, and asserts neither spawned anything once the close returns.
The existing tests that assert the old behaviour are changed and named in the commit message, as of this filing "accepts a prompt without waiting for the turn, attaching if needed" and "spawns a virtual session on its first prompt with no resumeId", which becomes an explicit attach followed by a prompt.
`bun run check` passes, and the Emacs suite passes with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.

OW-luwowo, on routes that do not refuse service during shutdown, gains the five routes from this change, since they no longer reach `attach`'s `#shuttingDown` check; this card does not take that on.

## Close note

Landed on main as 7a56fa8 and 1ef0e5d.
The prompt, fork, fork-points, model and effort routes in `src/server/http/app.ts` no longer attach: a request for a session not attached is answered 409 `not_attached` through a `notAttached(ref)` helper, the code `reply` already used, and only the `GET` of `ROUTES.session` spawns.
`attach` keeps its `#disposing` wait; no close guard was added.
Verified by six tests in `src/server/http/app.test.ts` under "only the attach route starts an agent (D25, OW-sirofi)": one per route asserting the 409 and that the adapter factory created nothing, each red against the old code, and one that closes an attached session with its disposal held, answers a prompt and a model inside that window (409 each, nothing spawned), then releases it; against the old app.ts that test hangs on `#disposing` and times out.
Existing tests changed and named in 7a56fa8's message; "keeps an error the adapter raised while the prompt that started it was being admitted" was removed, since no prompt starts a session, and no client omits `priorErrorId`, so OW-bomolu's test covers the reachable case.
Client audit: both clients attach explicitly on every deliberate path, no client change; the one exception, a browser selection whose live view a listing dropped, is OW-zivamo.
Every copy of the old behaviour retired across app.ts, session-manager.ts, protocol.ts, src/emacs/helper.ts, emacs/agentpane.el (including the `agentpane-close-session` docstring the review caught), emacs/agentpane-test.el, and D9, D21 and D25 in `docs/DESIGN.md`.
`bun run check` passes (1468 tests), the Emacs suite passes (200 run, 3 skipped), `bun run test:browser` passes (26).
The adversarial read also found that `close()` sets `torndown` only after awaiting parked-fork disposal, so a start publishing in that window reads as attached; added to OW-vodinu.
Left as noticed, not filed: the not-attached refusal is 409 at these routes and `reply` but 404 `not_found` from `#serially`/`requireAttached` (`compact`, `abort`, a verb queued behind a close); no client distinguishes them.
The `agentpane--spawn-timeout` docstring now records that `sessions/prompt`, `sessions/forkPoints` and `sessions/fork` keep the 60s timeout although they no longer spawn, unweighed.
