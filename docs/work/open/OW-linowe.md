---
labels: [defect, emacs, sweep-0929]
---

# A detach without a handle still drops the Emacs helper's attachments by ref, so killing a buffer the helper let go of silences another buffer attached on that ref; the helper should record which handle each token's answer bound, and drop only that

Found 2026-09-30 by the adversarial read of OW-wukako, confirmed by reading `src/emacs/helper.ts` and `emacs/agentpane.el` at 0da9e24, not reproduced; it predates OW-wukako, which left it unchanged.
In service of what OW-wukako started: a detach from one agentpane-mode buffer touches nothing another buffer holds.

## What happens

Since OW-wukako, agentpane-mode sends every `sessions/detach` and `sessions/close` with the `token` of the buffer's last attach (`agentpane--attach-sent`) and its `handle` if it holds one (`agentpane--detach`, `agentpane-close-session`).
`forget` in `src/emacs/helper.ts` abandons the attach that token names if it is still waiting, drops the attachment under the handle if one came, and otherwise drops every attachment the helper last named to Emacs by the detach's ref -- unless the token named a waiting attach, the `else if (!pending)` OW-wukako added.
That exception is a guard at the site: the by-ref drop is the imprecise match, and the exception spares only one case of it.

The case it misses: buffer A attached ref R under H1 and was then let go -- a gapped `session/detached`, or an `ended` -- so it holds no handle, but `agentpane--let-go` leaves `agentpane--attach-sent` at its old token T.
Buffer B is attached to R under H2.
Killing A sends `sessions/detach {session: R, token: T}`; T's attach is long done and gone from `attaching`, so `forget` drops by ref, drops H2, and B hears nothing more until it re-attaches.
Before OW-wukako the detach carried no token and did the same.

The same by-ref drop is the first of the "Two cases stay" in the `agentpane--detach` docstring (a buffer whose attach failed outright, killed after another buffer's session was renamed onto its ref).
The second -- a buffer killed after the helper sent the snapshot answering its attach and before Emacs handled it, while another buffer holds that handle -- is shared by handle and is not in scope unless the fix settles it for free.

## The direction

The OW-wukako reader's suggestion, a direction and not a prescription: the helper records, per token, the handle its answer recorded (`answer` in `src/emacs/helper.ts`), clears that record wherever the attachment goes (`drop`, `end`, `detachGapped`), and a detach without a handle drops only the handle its token recorded; the by-ref loop in `forget` and the `!pending` exception both go.
Where a token's record is cleared matters: a let-go buffer's token must drop nothing.

Two related orderings the same reader rated plausible, read and not run, which a per-token record may also settle; say in the close note whether it did:
- `agentpane--notified-buffer` in `emacs/agentpane.el` falls through to its ref fallbacks for a snapshot whose `token` no buffer holds, such as one answering a buffer killed before handling it, and can bind a preview that never sent an attach.
- A buffer's detach by handle H processed after the helper sent another buffer's tagged snapshot under H drops H, and the other buffer binds H and hears nothing.

## Done when

A test in `src/emacs/helper.test.ts`, red first: attach R from token 1 and receive its snapshot under H1; a gapped or `ended` let-go of H1; attach R from token 2 answered under H2; `sessions/detach {session: R, token: 1}`; a later event under H2 still reaches Emacs.
The `forget` docblock and the `agentpane--detach` docstring's "Two cases stay" paragraph describe what remains, and the by-ref loop in `forget` and its `!pending` exception are gone.
`bun run check` passes, and so does `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
