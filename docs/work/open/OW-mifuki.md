---
labels: [defect]
---

# `forkAndSubmit` ignores a selection made during its round trip, and a failed send leaves follow and the badge armed on the parent

Both traced by reading on 2026-09-09, neither reproduced; the tests named below are the reproduction.

`src/client/controller.ts`, `forkAndSubmit`: it bumps `selectionIntent` and never compares it back after its awaits, where `attachAndSelect` in the same file does (`if (disposed || intent !== selectionIntent) return false`).
A click on another session during the fork's attach and prompt is yanked back to the fork.
Then `src/client/App.svelte`, in `send()`'s edit branch, runs `rekeySession(armedKey, sessionKey(now))` against whatever `now` is, so the parent's scroll, follow, and badge state moves onto an unrelated session if the user did switch.

`App.svelte`, `send()`: `armFollow(...)` and `armBadge()` run before the request, and neither is disarmed when `controller.submit()` or the fork rejects.
The next stream on that session from any source, another tab or a resumed turn, engages follow and can badge the tab for a turn this tab never sent, which contradicts the rule in `src/client/favicon.ts` that the badge marks turns this viewer started.

## Done when

- A test in `controller.test.ts` starts `forkAndSubmit`, selects another session while the fake fork is held, releases it, and asserts the selection is the second session; it fails before the change.
- A test in `App.test.ts` makes the prompt reject and asserts a subsequent stream on that session neither engages follow nor badges; it fails before the change.
