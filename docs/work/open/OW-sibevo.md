---
labels: [change, emacs]
---

# agentpane-mode draws an image part as an [image <mime>] line, where the browser draws the image itself

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

`src/client/render/ImageBlock.svelte` draws a user image or a tool-result image as a `data:` URL, and checks the mime type against an allowlist rather than trusting it.
`agentpane--image-line` in `emacs/agentpane.el` inserts only the text `[image <mime>]`, both for a user message's images and for those in a tool result's fold.

The wire is enough: an image part carries its base64 `data` and `mimeType` (`src/emacs/protocol.ts`).
A frame that cannot display images, including the `--batch` the tests run under, still needs the text line, so the fallback stays.

The browser's behaviour is pinned by `src/client/render/Block.test.ts` "renders an image block as a data url" and "refuses an image block whose mime type is not an image".
ERT `agentpane-test-tool-result-images-in-the-fold` in `emacs/agentpane-test.el` pins today's text line; it runs under `--batch`, where the fallback still draws that line.

Done when ERT tests go red before the change and green after.
One stubs whatever display predicate the code gates on, since neither `--batch` nor a tty frame can display images, and sees a PNG part inserted with an image `display` property.
One sees a part whose mime type is not an image refused.
