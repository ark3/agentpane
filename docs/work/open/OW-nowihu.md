---
labels: [defect, emacs]
---

# The Emacs helper records one token per attachment, so a detach still drops a handle another buffer's attach was answered under, and an attachment whose answering buffer is gone is never dropped; since agentpane-mode lets one buffer hold a handle, the latest answer under a handle should own it

Found 2026-09-30 by the adversarial read of OW-linowe, which replaced `forget`'s by-ref drop with a per-token record; that record is the check this card replaces.
Confirmed by reading `src/emacs/helper.ts` and `emacs/agentpane.el` after OW-linowe landed; case 1 below was reproduced as a helper-level ordering by the reader, the others were read and not run.
In service of what OW-wukako and OW-linowe pursued: a detach from one agentpane-mode buffer touches nothing another buffer holds, and nothing the helper holds is left with no buffer to stop it.

## The mechanism being replaced

`answered` in `runHelper` (`src/emacs/helper.ts`) maps a token to the handle of the attachment its answering snapshot *created*: `answer` sets it only where `attached` did not already hold the handle, `drop` clears every token pointing at the dropped handle, and `forget` drops `handle ?? answered.get(token)`.
It stands in for state the helper does not keep: which buffers hold a handle.
So a buffer holding no handle, killed, cannot tell "nobody else holds H" from "another buffer holds H", and a buffer holding H cannot tell whether it is the last.
The `forget` docblock ("What stays"), the `answered` comment, and the "One case stays" paragraph of the `agentpane--detach` docstring in `emacs/agentpane.el` describe what it leaves.

## The cases it misses

1. X's attach (token 2) is answered under h1, creating the attachment, and its snapshot goes out; Y's attach (token 3) is answered under h1 after it, and its snapshot goes out; X is killed before Emacs handles token 2's snapshot and sends `sessions/detach {session, token: 2}`.
   `forget` drops h1; Y then binds h1 by its token, counts itself attached, and hears nothing.
2. Buffer A holding H is killed, or closes, and its detach by handle H reaches the helper after the helper sent another buffer B's tagged snapshot under H: `drop(H)` goes, and B binds H and hears nothing.
   The OW-wukako reader first named this ordering; OW-linowe left it unchanged.
3. X sends an attach with token 1 that times out in Emacs, then sends token 2; the helper answers token 1 under H, which no buffer binds (`agentpane--notified-buffer` finds no holder of token 1 and falls through); X is killed while token 2 is still waiting, so its detach abandons token 2 and has nothing recorded to drop.
   H stays attached with no buffer, and the helper keeps sending under it.
4. Emacs side: `agentpane--notified-buffer` falls through to its ref fallbacks (`agentpane--buffer-for`) for a snapshot whose `token` no buffer holds -- one answering a buffer killed before handling it, or a superseded token as in 3 -- and can bind a preview that never sent an attach, which then counts itself attached; after OW-linowe the helper may meanwhile have dropped that attachment, so the preview hears nothing.
   The OW-linowe implementer suggested such a snapshot bind at most the buffer already holding its handle.

A constraint any fix meets: `agentpane--absorb` removes the absorbed buffer's `kill-buffer-hook` detach before killing it, so the absorbed buffer's token is never released to the helper today; per-handle holder tracking needs Emacs to release it, or the helper to learn of the merge some other way.
Every `g` on an attached buffer (`agentpane-refetch`, through `agentpane--attach` with a fresh token) is another token answered under a handle already held.

## The direction

The OW-linowe reader's suggestion, a direction and not a prescription: the helper keeps, per attached handle, the tokens whose answers bound a buffer to it; a detach or close names the token it holds (and the handle), releases that one token, and drops the attachment only when its last token goes.
Whatever the design, the per-token `answered` record goes with it; this card changes who owns "who holds H", it does not add a case to `answered`.

## Done when

Tests in `src/emacs/helper.test.ts`, each red first against the helper as OW-linowe left it, for cases 1, 2 and 3: after the detach, a later event under the handle still reaches Emacs in 1 and 2, and in 3 the attachment is gone (a later event under H goes out to nobody).
An ERT test in `emacs/agentpane-test.el`, red first, for case 4, run as `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
`answered` is gone from `src/emacs/helper.ts`, and the `forget` docblock, the `agentpane--detach` docstring, and the `sessions/detach` entry in `src/emacs/protocol.ts` (which the header docblock says to raise when the wire changes) describe the new rule with no remaining case, or name exactly what remains.
`bun run check` passes.

## Amended 2026-09-30: build on the one-buffer-per-handle guarantee, and stop at what it leaves

The direction above, every token holding each handle, tracks a state agentpane-mode already rules out: at most one buffer holds a handle, since `agentpane--attach-by` in `emacs/agentpane.el` has the buffer that asked absorb any other holding the handle (`agentpane--absorb`, whose docstring says why two holders cannot stand).
So the helper's "several tokens under H" exists only while snapshots are on their way to Emacs, and the buffer that survives is always the one whose answer came last.
That suggests a smaller rule, a direction and not a prescription: the helper keeps, per attached handle, the token of the latest answer under it, and a detach or close drops the attachment only when its token is that one, handle or not.
It appears to settle cases 1 and 2, and is consistent with a merge (the absorbed buffer never detaches, and the survivor holds the latest token) and with `g` (`agentpane-refetch`'s fresh token becomes the latest); check both.
Case 3 needs the helper to know that two tokens came from one buffer; settle it only if that is cheap, and otherwise name it where what remains is named.
Case 4 is agentpane-mode's alone, and the OW-linowe implementer's suggestion, that a tagged snapshot no buffer's token matches binds at most the buffer already holding its handle, may be all it needs.

The owner set a stopping rule for this chain (OW-wukako, OW-linowe, this card) on 2026-09-30: whatever ordering this card's adversarial read finds that the rule leaves, it is named in the `forget` docblock and the `agentpane--detach` docstring and accepted, not filed as another card.

This amends the "Done when" above: the red-first helper tests are for cases 1 and 2, and for case 3 only if it is settled; the ERT test for case 4 stands; `answered` is gone, replaced by whatever the helper keeps per handle; and what remains is named, not required to be nothing.
