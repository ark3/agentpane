---
labels: [defect]
---

# Detaching any new session before its first turn previews an id with no store file, because every backend renames its virtual ref at attach

Found 2026-09-23 by the adversarial reader on OW-hojefo, from the code; not run in a browser.
Widened the same day by OW-bohodu from Codex alone to all three backends and to forks: see "What OW-bohodu added" below.

## What the code does

The detach path in `src/client/controller.ts` (the branch reading `if (selected.id.startsWith("virtual:"))`, with the comment block above it naming OW-vasubu, D21 and this card) decides whether a detached session has anything on disk by its id alone: a `virtual:` id lands on the startup view, anything else falls through to `controller.preview(selected)`.
For Codex that does not hold: `CodexAdapter.start()` in `src/server/adapters/codex/adapter.ts` runs `thread/start` at attach, and the session manager's `#adoptRef(bound, "rename")` in `src/server/http/session-manager.ts` renames the `virtual:` ref to the thread id then, before any turn.
As of `codex-cli 0.156.0` a thread with no turn has no rollout (`docs/MANUAL_TESTING.md`, OW-hojefo: `thread/resume` of it failed with `-32600 no rollout found for thread id`).
So detaching or closing a new Codex session before its first prompt previews a thread the session index cannot find, the stranded preview OW-vasubu exists to prevent.
Since OW-hojefo the same state is reachable from a Codex fork at the first user message: its `virtual:` ref is renamed to a fresh thread at attach, and the Emacs fork (`agentpane--fork-at` in `emacs/agentpane.el`) submits nothing, so the fork sits turnless until the user prompts.

## What OW-bohodu added

D9 in `docs/DESIGN.md` now records, per backend and with versions, that every backend replaces the `virtual:` id at attach and none writes a store file until the first turn: Pi names its file from `start()`'s `get_state` but, as of `pi 0.87.1`, writes nothing until an assistant message exists (measured, and `_persist` in Pi's `dist/core/session-manager.js`); Claude Code's id is the uuid `ClaudeAdapter` mints for `--session-id`, and as of `claude 2.1.280` its store file appears only after the first user message (`docs/MANUAL_TESTING.md`, "When a new Claude Code or Pi session first reaches disk (OW-bohodu)").
So the `virtual:` exit never runs for a session created in the browser, on any backend: `create()` goes through `attachAndSelect`, which selects the renamed ref.
D21's paragraph beginning "It stays on `detach()`'s virtual exit" now says so, and `src/client/controller.test.ts`'s virtual-exit tests (around "lists as `attached` while its id is still virtual") exercise an exit production does not reach.

What the user sees, traced by OW-bohodu's reader and not run: `readSessionPreview` in `src/server/sessions/preview.ts` answers the renamed ref with a 200 and `turns: []`, so `App.svelte` shows its preview branch with only an Attach button and the preview poll keeps fetching empty; Attach then 404s with `UnknownSessionError`, because `close()` dropped the session and its aliases.
With the stream down the sidebar row also stays as a clickable phantom, since the exit's `refreshSessions(false)` never runs — the loss D21 describes.

Forks reach the same state on every backend: a fork's container is created with `virtual: false` and `fromStore: false` in `SessionManager`'s `#start`, with no file behind it until its first turn ends — Claude Code at any fork point (OW-japuzo), Codex at the first user message (OW-hojefo), and Pi at the first user message (from Pi 0.87.1's source, `agent-session-runtime.js` calling `newSession()`; not run).
So the server's `virtual` flag is not the signal either: it is set only while nothing is on disk, but it clears at the first prompt, before any backend writes, and a fork never has it.

The Emacs client does not share the bug as of this writing: `agentpane--detach` sends `sessions/detach`, which unsubscribes and leaves the session running, and never closes it.

## Done when

A test beside the existing OW-vasubu/OW-tewave detach tests in `src/client/controller.test.ts`, red first, shows detaching a session that was renamed at attach and has run no turn landing where a detached `virtual:` session lands, not on a preview of its id; and a second, red first, shows the same for a fork that has run no turn.
Rework or retire the existing virtual-exit tests so they drive a ref production can actually hold.
What signal distinguishes "nothing on disk" once the id is no longer `virtual:` — a summary field the server derives from the store, or something else — is the implementer's call; it must cover forks, which the `virtual` flag does not.
If the Emacs client gains a close path, it gets the same behaviour or its own card per `AGENTS.md`, "Both clients".
