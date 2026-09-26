---
labels: [change, emacs]
---

# agentpane-mode can copy only the text shr drew for a block, where the browser's Copy takes the block's markdown source

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

Each browser text, thinking or output block has a Copy control, and so does the Expand panel ("Copy all"), and each copies the block's markdown source rather than its rendered prose: `src/client/render/BlockActions.svelte` and `src/client/render/CopyButton.svelte`.
In `emacs/agentpane.el` the only copy is the kill ring over what `shr` inserted, which drops the markdown.

The wire is enough.
A text node's `text` is its markdown source, alongside the `html` drawn from it (`src/emacs/protocol.ts`, the `{ type: "text", text, html }` entry), and a thinking part carries its `text` too.

The browser's behaviour is pinned by `src/client/render/BlockActions.test.ts` "copies a text block's markdown source, not its rendered prose" and "copies the whole source from the panel".

Done when an ERT test in `emacs/agentpane-test.el` runs the command at a text node whose markdown differs from its rendering and finds that markdown at the head of the kill ring, red before the change and green after.
