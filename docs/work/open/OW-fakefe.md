---
labels: [defect, emacs]
---

# With no server listening, jsonrpc's 'Server exited with status 0' overwrites agentpane-mode's 'could not reach the agentpane server' in the echo area of an interactive Emacs

Found 2026-09-29 by OW-pezelo's adversarial read.
In service of D25 point 4 in `docs/DESIGN.md`, that with the server down a request fails there visibly: legibly enough that the user knows to start the server.

## What happens

Since OW-pezelo, the helper (`runHelper` in `src/emacs/helper.ts`) answers a `sessions/list` or `sessions/attach` waiting on a failed first open with `-32603` "could not reach the agentpane server", then exits.
`agentpane--request` in `emacs/agentpane.el` shows it as "agentpane: sessions/list failed: could not reach the agentpane server".
When Emacs handles each message as it comes, as an interactive session does, that reply is handled before the process's exit, and `jsonrpc--process-sentinel` then writes "[jsonrpc] Server exited with status 0" (jsonrpc.el 1.0.29, `jsonrpc--message`) over it, so the reason survives only in `*Messages*`.
Measured 6 runs of 6, Emacs 31.1 batch, bun 1.4.0; see `docs/MANUAL_TESTING.md`, "With no server listening, the helper answers the requests waiting on its first open before it exits (OW-pezelo)".
Before OW-pezelo the echo area ended on agentpane's "the helper exited", which `agentpane--answer-deaths` writes two zero-delay timers after the sentinel, so this ordering is new with it, though the jsonrpc line itself is not.
The same holds for any error reply a dying helper writes, such as the socket error OW-hiliti measured with the server killed mid-prompt.

## Done when

With the helper run against a port nothing listens on and Emacs handling messages as they come, the last message in the echo area after a `sessions/list` names the reason the helper gave, not jsonrpc's exit line.
Show it red first: extend or copy `resources/probes/emacs_helper_no_server_probe.py`'s setup into an Emacs batch probe, or an ert case in `emacs/agentpane-test.el` driving the real helper, that records `current-message` (or every `message`, in order) and fails on the current code.
Whether agentpane-mode silences jsonrpc's line, or re-shows the reason from its teardown, is the implementer's call; either must keep the ert suite and `bun run check` green.
