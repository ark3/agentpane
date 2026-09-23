---
labels: [defect, emacs, emacs-native]
---

# agentpane-fork from a previewed buffer matches a stored-transcript index against the live adapter's fork points, which can name a different message

Found by the adversarial read of OW-fojike, 2026-09-22.
In service of `f` forking at the message the user is looking at, never silently at another.

`agentpane-fork` in `emacs/agentpane.el` reads the index of the node at point and matches it against `sessions/forkPoints`.
In a buffer that is only previewed, that index comes from the stored projection (`src/server/sessions/codex.ts` for Codex, and the Pi and Claude stores beside it), while the `fork-points` route in `src/server/http/app.ts` attaches first and answers from the live adapter's transcript.
Where the two projections disagree the same index names different messages: a Codex fork's stored transcript lacks its inherited turns (OW-buligi; `docs/MANUAL_TESTING.md`, "The native Emacs mode forks a Codex session live (OW-fojike)"), so `f` on its visible prompt at index 0 matches the live point for the inherited first message and forks that instead, with no warning.
The reader's ert probe `probe-preview-index-misfork` (`/tmp/apfork/probe.el` on the home server, may not survive) shows the mode sending that fork; that the live points index the inherited turn is inferred from the live snapshot, not measured.
Pi's stored preview also drops `custom_message` entries and roles such as `bashExecution` that `get_messages` keeps, read from `pi 0.87.1`'s source.

The browser never makes the comparison: a previewed session offers no Edit control (`src/client/App.svelte`, the `{#if previewing}` branch).
OW-fojike's card allowed forking a previewed session on the premise that the result attaches; it did not consider the index spaces.
Also from the adversarial read of OW-yoyiya: `agentpane-fork` sends `sessions/forkPoints` on a previewed buffer with no attach first, and that route attaches (`sessions.attach(ref)` in the fork-points case of `src/server/http/app.ts`), so it can cold-spawn the backend under jsonrpc.el's 10s default rather than `agentpane--spawn-timeout`, and `sessions/fork` after it likewise.
Whichever way the decision below goes, the requests that may spawn take `agentpane--spawn-timeout`.
The decision this card gates is whether `f` on a previewed buffer attaches and redraws first, refuses as the browser does, or trusts the indices; record it in `agentpane-fork`'s docstring.

Done when an ert test on a previewed buffer whose stored and live indices differ shows `agentpane-fork` not forking at the wrong message, red before the change.
