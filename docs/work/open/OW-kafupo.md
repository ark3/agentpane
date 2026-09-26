---
labels: [change, emacs]
---

# A previewed transcript in agentpane-mode stays as drawn until g, where the browser's preview refreshes itself (OW-76)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser polls the previewed session on an adaptive schedule, and also refreshes it when the tab regains focus or visibility: `refreshPreview` and the poll timer in `src/client/controller.ts`, with the schedule in `src/client/preview-poll.ts` (closed OW-76).
A preview buffer in `emacs/agentpane.el` is redrawn only by `agentpane-refetch` (`g`).

The wire is enough: `sessions/preview` exists, and the poll is client-side.
The Emacs analogue of the browser's visibility gate is this card's to choose, for example polling only a preview shown in some window.
What is load-bearing is that a preview nobody is looking at costs nothing.
In the browser that gate is `syncPoll` and `refreshPreview` with the injected `isVisible` in `src/client/controller.ts`, fed by the `visibilitychange` and `focus` listeners in `src/client/App.svelte`; `src/client/preview-poll.ts` holds only the backoff, `nextPreviewDelay`.

The browser's behaviour is pinned by the "preview self-refresh" block in `src/client/controller.test.ts` and by `src/client/preview-poll.test.ts`.

Done when an ERT test in `emacs/agentpane-test.el` sees a shown preview buffer re-request `sessions/preview` with no keypress, and one not shown in any window not do so, red before the change and green after.
