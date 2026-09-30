---
labels: [defect, emacs]
---

# agentpane-send and agentpane-compact re-attach a Pi fork's parent that the server has let go while the fork is in flight, because the fork refusal sits in each command rather than in agentpane--attach

Found 2026-09-29 by the adversarial read of OW-bupivi, and reproduced with a throwaway ERT probe built on the test helpers in `emacs/agentpane-test.el`; not reproduced against a real backend.
In service of a Pi fork leaving its parent detached as `agentpane-fork`'s docstring promises ("At the reply this buffer counts itself detached, and not dropped"), whichever command the user presses during the fork.

## The race

`#forkOnto` in `src/server/http/session-manager.ts` broadcasts `ended` for a Pi fork's parent and takes it out of the table before the fork's reply goes out: the adapter still re-sends the model and level and hydrates the fork's transcript after the move.
The helper passes that on as `session/detached`, and `agentpane--let-go` leaves the parent buffer not attached while `agentpane--forking` is still set.
In that window, any command that attaches sends `sessions/attach` for the parent's ref, and `#forkOnto`'s docblock says "the next attach resumes the parent from the index", which respawns the parent's old branch.
The fork's reply then runs `agentpane--fork-at`, which calls `agentpane--detach` and sets `agentpane--attached` and `agentpane--dropped` to nil, so the respawned process runs with nothing listening; or, if the helper gave up the pending attach at that detach, the prompt fails, leaving the draft in place, while the server has still respawned the parent.

The probe: a Pi buffer, attached; `agentpane-fork` with the `sessions/fork` reply held; `session/detached` delivered for the parent's handle; text in the prompt region; `agentpane-send`.
It sent `(sessions/attach sessions/prompt)` for the parent's ref, and releasing the fork's reply then sent `sessions/detach` for it.

## Who guards it today

`agentpane-fork`, `agentpane-edit`, `agentpane-edit-last` and, since OW-bupivi, `agentpane-attach` each refuse at the top while `agentpane--forking` is set, and `agentpane-refetch` refuses there with a message.
`agentpane-close-session` refuses on it too.
`agentpane-send` reaches `agentpane--send-prompt`, which checks only `agentpane--sending` and `agentpane--editing`; a plain `f` fork never sets `agentpane--sending` (only `agentpane--send-edit` does), so nothing stops it.
`agentpane-compact` goes through `agentpane--attached-then` with no fork check.
`agentpane-set-model` and `agentpane-set-effort` are held off by `agentpane--check-gate`, per the reader; confirm that.

So the refusal is a guard at each site, and the sites it misses are the defect.
The state it guards belongs to the attach: what must not happen during a fork is an attach of this buffer's session, not any particular command.

## What to build

Move the fork refusal into `agentpane--attach` (and `agentpane--attach-now`), beside `agentpane--refuse-closing`, and retire `agentpane-attach`'s own `agentpane--forking` check, which becomes redundant.
The reader's unverified suggestion, to confirm before building on it: the refusal must not go into `agentpane--attached-then`, because prompting a Codex or Claude Code parent that stays attached through its fork is legitimate there; it would not break `agentpane--fork-at`, which clears the parent's flag before attaching the fork's own buffer, nor `agentpane--send-edit`, which attaches before `agentpane--fork-points` sets the flag.
The guards in `agentpane-fork`, `agentpane-edit` and `agentpane-edit-last` also enforce one fork at a time on an attached buffer (OW-kelede), so they stay unless the change shows one of them to be only this check; say in the close note which were retired and why.

## Records that change with it

`agentpane-fork`'s docstring gives the wrong reason for `agentpane-refetch` sending nothing during a fork: "on the attached parent it would attach again, and a reply to that landing after the fork's would count the parent attached, the server having detached it".
Since OW-rebawa a reply attaches nothing; only the snapshot does (`agentpane--attach-by`).
The true reason is the race above: a refetch attach reaching the server after `#forkOnto` respawns the parent's old branch, and whether the buffer then holds that respawn or the fork's reply detaches it depends on which of the snapshot and the reply is handled first.
Restate it.

Same root, found by the same read: `agentpane--watch-submit`'s docstring still says "whichever of the attach's snapshot and its reply is handled first (D2): either the level is folded here, or the snapshot's status folds it after", but since OW-rebawa the helper writes the attach reply only after the snapshot (`sessions/attach` in `src/emacs/helper.ts`), so the snapshot always comes first and the second branch cannot happen.
Restate that clause too; its conclusion still holds.

## Done when

An ERT test in `emacs/agentpane-test.el` reproduces the probe above: a Pi buffer attached, a fork held, `session/detached` delivered for the parent's handle, then `agentpane-send` with a draft and `agentpane-compact` each refused with nothing sent.
It is red before the change and green after.
`agentpane-attach`'s own `agentpane--forking` check is gone, and `agentpane-test-attach-on-a-preview-attaches-and-goes-to-the-prompt`'s refusal assertion still passes through the moved guard.
The suite passes: `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`.
