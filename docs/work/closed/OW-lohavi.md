---
labels: [change, emacs]
closed: done
---

# agentpane-mode does not tell a user that a turn they submitted finished while they were elsewhere, as the browser's favicon badge does (OW-diyuwu)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser badges its favicon when a turn the user submitted ends while the tab is unfocused, and clears the badge on focus: `watchSubmit`, `watchSessions`, `watchFocus` and `setFaviconBadge` in `src/client/favicon.ts` (closed OW-diyuwu, and D17 on its arming moving to a fork's handle).
`emacs/agentpane.el` has nothing: a turn ending in a buffer not shown says nothing.

The wire is enough.
Only an attached session can be submitted to, and every attached buffer already hears its `session/status`.

The Emacs form -- a mode-line indicator, a message, a notification -- is this card's to choose.
What is load-bearing is the watch's semantics: only a turn this Emacs submitted arms it, not one it merely watched, and seeing the session disarms it.

The browser's behaviour is pinned by the "the turn-done watch" block in `src/client/favicon.test.ts`.

Done when ERT tests in `emacs/agentpane-test.el` go red before the change and green after.
One sees the indicator raised when a submitted turn ends in a buffer not shown, and cleared on showing it, and one sees no indicator for a turn this Emacs did not submit.

## Close note

Landed 2026-09-27 as 3ae09df and e8cc0a3 in `emacs/agentpane.el`.
A turn this Emacs submitted that ends while no window shows its transcript buffer puts a red ` ●agentpane` (face `agentpane-turn-finished`, help echo naming the buffers) into `global-mode-string`, so every mode line draws it, the favicon badge's counterpart.
Showing the buffer clears it through the existing `window-state-change-functions` owner `agentpane--clear-seen-turns`, using `agentpane--shown-p`, extracted from `agentpane--seen-p` so both features read "shown" alike; killing the buffer clears it too.
The watch is buffer-local `agentpane--turn-watch`, armed in `agentpane--send-prompt` after any attach and folded from `agentpane--set-status`; done is not-streaming after streaming, as `watchSessions` reads it.
A mid-turn prompt (Codex or Pi steer) makes the running turn this Emacs's: arming folds the current level, as the browser does at the publish after its submit, and that also makes the attach reply/snapshot order irrelevant.
Nothing moves to a fork: an Emacs fork sends no prompt and opens its own buffer.

Verified on Emacs 31.1: nine `agentpane-test-turn-done-*` ERT tests; the five that expect a raise went red against the unchanged code (the reply-first attach half excepted, which already raised), and the four negative ones were each shown red under a mutation of the change (arming every turn, done read as a level, no disarm on refusal, no disarm guard on a refused mid-turn prompt).
Full batch suite 149 run, 0 unexpected, 3 skipped; tty suite 3 of 3; a real `emacs -nw` mode line drew the indicator and a redisplay cleared it.

The adversarial read's remaining cases went to OW-dunahe (the watch's owner: merge via `agentpane--absorb`, detach before streaming, prompt timeout, Pi fork's late status) and OW-ratati (a non-list `global-mode-string`).
