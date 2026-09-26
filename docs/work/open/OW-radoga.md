---
labels: [change, emacs]
---

# agentpane-mode's new session asks for a backend with no default and takes the calling buffer's project, where the browser's New conversation inherits the selected session's backend and workspace (OW-72)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser composer's New conversation creates a session on the selected session's backend in the selected session's workspace: `newConversation` in `src/client/App.svelte` (closed OW-72).
`agentpane-new-session` in `emacs/agentpane.el`, run from a transcript buffer, reads the backend with no default, and takes the cwd from `agentpane--current-cwd`.
That is the project root of the buffer's `default-directory`.
Since OW-ruhotu, `agentpane--transcript-buffer` sets a transcript's `default-directory` to its session's cwd, so the two differ only where that cwd sits below a project root, which `project-current` climbs to, or no longer exists.
The missing backend default is the larger half of the gap.

The wire is enough: `sessions/create` takes a backend and a cwd.
The browser's behaviour is pinned by `src/client/App.test.ts` "the composer's New conversation inherits the selected session's workspace AND backend (OW-72)".
Run from a buffer that is not a transcript, today's behaviour stays.

Done when an ERT test in `emacs/agentpane-test.el`, using the stubbed request that `agentpane-test--new-session` sets up, runs the command from a transcript whose session's cwd differs from the buffer's project, and sees `sessions/create` sent with that session's backend and cwd, red before the change and green after.
