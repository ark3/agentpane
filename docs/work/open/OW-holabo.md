---
labels: [question]
---

# Remote markdown images load on render, so a transcript from an untrusted repository can beacon the reader's address and time to a host of its choosing

`src/client/render/markdown.ts`: the sanitizer profile keeps `<img>` with `http(s)` sources, so `![](https://host/x.png)` in assistant text or a tool result fetches on render.
That is not XSS; every sink still ends in DOMPurify (`docs/WORKSTREAMS.md`, "Everything the renderer puts on the page is sanitized").
It is a beacon: the request carries the reader's IP and the moment they opened the transcript, and D5's stated threat is "rendering the contents of repositories we do not control".
OW-kehose is the adjacent open card, on rendering a `data:` image the agent generated; that path has no network side.

The decision is whether remote images are a feature worth that channel.
Rendering them as a link the reader clicks keeps the information and drops the automatic fetch; keeping them as images accepts the beacon and should say so.

## Done when

The decision is recorded under D5 in `docs/DESIGN.md`, and, if remote images are dropped, a test in `markdown.test.ts` asserts an `http` image source renders as a link; it fails before the change.

**Amended 2026-09-09 at execution: the card is right and its scope is too narrow.**

Reproduced by running each source through `renderMarkdown` (throwaway probe, not committed).
`![](https://host/x.png)` renders `<img src="https://host/x.png" alt="">`, confirming the beacon.
`<img src=x onerror=alert(1)>` renders `<img src="x">`, confirming this is not XSS.
A link renders with `target="_blank" rel="noopener noreferrer nofollow"` and fetches nothing.

**The beacon surface is wider than `![]()`.**
Each of these also survives `sanitize()` with its remote URL intact, and every one of them fetches or preloads on render:

- raw `<img src="https://…">` written as HTML in assistant text, not markdown image syntax at all;
- `<img srcset="https://… 1x">`;
- `<video src="https://…" poster="https://…">` — `poster` fetches immediately;
- `<audio src="https://…">`;
- `<picture><source srcset="https://…"></picture>`;
- a protocol-relative `<img src="//host/x.png">`, which no `http`-prefix check catches.

`<input type=image src=…>` is dropped, because `input` is in `FORBID_TAGS`, and the `ping` attribute on an anchor is stripped.
So a fix written as an override on marked's image token would miss every item on that list.
The choke point that sees all of them is `sanitize()` in `src/client/render/markdown.ts` — a DOMPurify `afterSanitizeAttributes` hook, beside the one already there for anchors.

**There is no Content-Security-Policy anywhere in this repo.**
`grep -rni "content-security-policy"` over `src/`, `public/`, `e2e/` and `docs/DESIGN.md` is empty, and `src/server/http/static.ts` sets no such header.
That makes a third option available that this card did not list, and it is the stronger mechanism: `Content-Security-Policy: img-src 'self' data:; media-src 'self' data:` on the served HTML stops every vector above at the browser, including ones the sanitizer does not know about yet, and it needs no per-element rules.
It is also narrow enough not to disturb the app — naming only `img-src` and `media-src` leaves scripts, styles and everything else unrestricted, so nothing that works today stops working.
The two are not exclusive: the header is the boundary, the sanitizer decides what the transcript *means*, and only the sanitizer can turn a blocked image into a visible link the reader can click.
