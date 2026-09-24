---
labels: [defect, emacs]
closed: done
---

# agentpane-new-session sends the effort without awaiting the model, so a slow setModel gets the effort refused against the old model

`agentpane-new-session` in `emacs/agentpane.el` calls `agentpane-set-model`, which sends `sessions/setModel` through `agentpane--request` with `#'ignore` as its callback and does not wait, then reads an effort with `agentpane--read-effort` for the model just chosen and sends `sessions/setEffort` through `agentpane-set-effort`.
The helper in `src/emacs/helper.ts` answers requests concurrently, and each becomes its own HTTP call.

Since OW-tewofe the effort route (`case "effort"` in `src/server/http/app.ts`) refuses with 400 an effort that the model in the session's `getState()` does not list.
So if the effort request reaches the server before the model change has landed, it is checked against the old model — or against none, for a session whose model is still null — and refused in the echo area, where before OW-tewofe it was accepted.
The minibuffer read of the effort sits between the two sends, so this needs a `setModel` slower than a human's choice; Codex's `setModel` makes a `listModels` round trip first.
Read from the code at the commit that landed OW-tewofe, not reproduced live.

The docstring of `agentpane-new-session` now describes this window; the fix would send the effort only once the model request has answered, e.g. from its callback, or with a synchronous `jsonrpc-request` as the attach already is, and would retire that sentence of the docstring.

## Done when

- An Emacs-side test (or a helper test, if the ordering can be pinned there) shows the effort request sent only after the model request answered, red first against the current fire-and-forget order.

## Close note

Landed in 290cdfd.
`agentpane-set-model` now takes an optional THEN, which runs once the server has answered `sessions/setModel`, runs at once for an empty model, and never runs if the request fails.
`agentpane-new-session` sends the model as soon as it is read, then sends the effort after both the model's reply and the effort's minibuffer read, whichever comes last.
A failed model is reported in the echo area and the effort read for it is not sent.
The docstring sentence describing the old race is gone.
Interactive `M-x agentpane-set-model` and `agentpane-set-effort` are unchanged.

Verified by the new ERT test `agentpane-test-new-session-sends-the-effort-once-the-model-answers`, whose harness holds the setModel reply until `agentpane-new-session` returns.
Run against the pre-fix `emacs/agentpane.el` it failed, with the effort sent before the reply; after the fix the full suite passes, 86/86.
Emacs-only change, so `bun run check` was not needed.

Left as is:
A setModel that exceeds jsonrpc.el's default 10s timeout but still succeeds on the server now drops the effort, where before the effort was sent anyway.
If a first prompt goes out before the model answers, the effort's prompt gate raises its user-error inside the reply callback rather than at the command.
