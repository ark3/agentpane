---
labels: [change]
---

# The browser keeps one composer draft across every session, where each agentpane-mode transcript keeps its own

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

The browser's composer holds a single `draft` on the controller's view (`src/client/controller.ts`), and switching sessions carries the text across.
The comment in the pane-switch effect of `src/client/App.svelte` records the behaviour: "switching sessions has never rewritten the composer".
It records no decision behind it.
Each transcript buffer in `emacs/agentpane.el` has its own prompt region and composer, so each keeps its own draft by construction.
The nearest ERT, `agentpane-test-attach-onto-a-held-handle-keeps-drafts` in `emacs/agentpane-test.el`, pins what happens to drafts when two buffers land on one handle.

Two other things hold a draft in the browser and bear on the change: the `stashedDraft` an edit keeps in `startEdit`, and the external editor round trip through `/api/edit-draft`.

Done when a test in `src/client/App.test.ts` types into session A, switches to B and finds B's own draft, then switches back and finds A's text, red before the change and green after.
