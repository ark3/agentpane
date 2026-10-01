---
labels: [defect]
---

# A Pi parent whose turn a fork aborts can get a finished dot on its row when the user clicks away before the abort's status:false arrives

Filed 2026-09-30 from the adversarial read of OW-pirobi; read at the code, not reproduced.

On Pi, `forkAndSubmit` in `src/client/controller.ts` stops a streaming parent's turn before forking it: `onAbort?.(handle)` then `await api.abort(selected)`, ahead of `api.forkPoints` and `api.fork` (the comment beginning "Stop a running turn before forking it on Pi, and nowhere else").
`send()` in `src/client/App.svelte` answers `onAbort` with `watchAbandon`, so the badge raises nothing for a turn the user stopped (OW-rihanu, OW-dunahe).
The row's turn marks have no such exemption: `foldSessionTurns` in `src/client/session-turns.ts` marks any key whose level goes `true` to `false` while another key is selected.
In the normal case the parent is still selected when its `status:false` arrives, so nothing is marked.
If the user clicks another session after pressing Send and before that `status:false` arrives, the parent's handle is marked finished: a dot announcing a turn the user just stopped, the row-mark counterpart of what OW-dunahe fixed for the badge.

Before OW-pirobi that mark was moved onto the fork's row once the fork resolved; since OW-pirobi it stays under the parent's handle.
Whether a row ever draws it is the first question: on Pi the parent's handle is let go after the fork, and `rowKey` in `App.svelte` falls back from `viewHandles` to `summary.handle` to `sessionKey(ref)`, so the dot shows only while some row still keys by that dead handle.
Trace or reproduce when the parent's summary stops carrying that handle; if no row can draw the mark, close this card `--moot` with that evidence.
The parity target is agentpane-mode: the passage in `emacs/agentpane.el` beginning "Nothing moves a mark or a level from a fork's parent to the fork" says a Pi parent's running turn "is aborted, and its handle let go"; check whether a buffer switch mid-fork there can mark it, and file what differs under the "Both clients" rule in AGENTS.md.
Stale keys under a let-go handle are OW-nodade's, not this card's.

Load-bearing: a turn the user stopped on purpose gets no finished mark, the same rule the badge follows.
Done when a test in `src/client/App.test.ts`, red first, drives the real controller through a Pi fork from a streaming parent, clicks another session before the parent's `status:false` is emitted, and asserts no row shows "Turn finished" for the parent; `bun run check` passes.
Or, if no row can draw the mark, when the card closes `--moot` with the trace that shows it.
