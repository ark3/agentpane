---
labels: [defect]
---

# Detaching a Codex session before its first turn previews a thread id with no rollout, because Codex renames its virtual ref at start

Found 2026-09-23 by the adversarial reader on OW-hojefo, from the code; not run in a browser.
Related to OW-bohodu, which finds the same D9 wording ("a virtual session materialises on its first prompt") already false for Pi.

## What the code does

The detach path in `src/client/controller.ts` (the branch reading `if (selected.id.startsWith("virtual:"))`, with the comment block above it naming OW-vasubu and D21) decides whether a detached session has anything on disk by its id alone: a `virtual:` id lands on the startup view, anything else falls through to `controller.preview(selected)`.
Its comment says the `virtual:` id "is replaced by a `renamed` event the moment a first prompt materialises a file, so it is true exactly while there is nothing on disk".
For Codex that does not hold: `CodexAdapter.start()` in `src/server/adapters/codex/adapter.ts` runs `thread/start` at attach, and the session manager's `#adoptRef(bound, "rename")` in `src/server/http/session-manager.ts` renames the `virtual:` ref to the thread id then, before any turn.
As of `codex-cli 0.156.0` a thread with no turn has no rollout (`docs/MANUAL_TESTING.md`, OW-hojefo: `thread/resume` of it failed with `-32600 no rollout found for thread id`).
So detaching or closing a new Codex session before its first prompt previews a thread the session index cannot find, the stranded preview OW-vasubu exists to prevent.
Since OW-hojefo the same state is reachable from a Codex fork at the first user message: its `virtual:` ref is renamed to a fresh thread at attach, and the Emacs fork (`agentpane--fork-at` in `emacs/agentpane.el`) submits nothing, so the fork sits turnless until the user prompts.

## Done when

A test in the client tests for the detach path (find the existing OW-vasubu/OW-tewave detach tests beside `src/client/controller.ts`), red first, shows detaching a Codex session that was renamed at start and has run no turn landing where a detached `virtual:` session lands, not on a preview of its thread id; the Emacs client gets the same behaviour or its own card per `AGENTS.md`, "Both clients".
What signal distinguishes "nothing on disk" once the id is no longer `virtual:` (a summary field, the session manager's `virtual` flag, or something else) is the implementer's call, and it should be the same signal OW-bohodu's Pi case needs.
