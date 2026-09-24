---
labels: [defect, emacs]
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
