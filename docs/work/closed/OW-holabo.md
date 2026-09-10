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

The owner took the decision on 2026-09-09: remote media does not load automatically; it renders as a link the reader clicks. Recorded as an amendment to D5 (e838662), implemented in `sanitize()` (8e345ae).

**The card was right and its scope was too narrow.** It described `![](https://host/x.png)` keeping an `<img>` with an http source, which reproduces exactly. But a probe through `renderMarkdown` found the same beacon in raw html `<img>` written in assistant text, `img srcset`, `<video src>` and its `poster` (which fetches before anything is played), `<audio src>`, `<picture><source srcset>`, and a protocol-relative `//host/x.png` that no `http`-prefix test catches. `<input type=image>` was already dropped, since `input` is in `FORBID_TAGS`, and the anchor `ping` attribute was already stripped. A fix written as an override on marked's image token — the obvious reading of the card — would have caught one case and missed six. Enforcement went into `sanitize()`'s existing `afterSanitizeAttributes` hook, the only place that sees all of them.

**A third option the card did not list turned out to be the stronger mechanism**, and both were taken. agentpane serves no `Content-Security-Policy` at all — the grep over `src/`, `public/`, `e2e/` and `docs/` is empty — so the renderer is currently the only thing between a hostile transcript and an outbound request, and it fails open invisibly: a widened DOMPurify profile, a new media element, or a future `{@html}` sink added without going through `sanitize()` reopens the channel and a successful beacon looks exactly like nothing happening. That half is **OW-kigole**, scoped to `img-src` and `media-src` only so it cannot break the app. The two overlap deliberately: the header is the boundary, and only the renderer can turn a blocked image into something a reader can click.

Implementation, by a dispatched implementer on `card/OW-holabo`, cherry-picked after review. A media element naming a remote URL is replaced by a span of links, one per URL it would have fetched, badged with what it was. `alt` labels the first link and `title` carries its destination; where there is no `alt` the full URL is the link text, deliberately untruncated so the reader can judge the host. Children move across rather than dying with the element, so a `<video>`'s `<source>` elements and fallback prose survive. `data:` and same-origin sources are untouched.

**Verified at the source rather than taken from the report.** The tests were re-run against the unmodified renderer in the worktree: 17 go red, including the `data:`-sibling and link-hardening cases, so they have been shown to test something. The security-relevant move — taking a URL validated in `src` context and writing it into an `href` — was probed directly: `javascript:`, `vbscript:` and mixed-case variants never reach the hook, because DOMPurify strips them from `src` first, so no scheme is laundered. The created anchors are re-walked by DOMPurify and pick up `target="_blank" rel="noopener noreferrer nofollow"` from the existing branch, which was asserted rather than assumed. A nested `<video src=remote><source src=remote>fallback</video>` yields links for both and keeps the prose. An uppercase `DATA:` URI loses its src, but it does so on `main` too — pre-existing DOMPurify behaviour, not a regression.

`bun run check` green (955 tests) and `bun run test:browser` green (20 specs) on `main` after the cherry-pick.

Left deliberately undone, with reasons at the code: `<track src>` is not linked, because a track loads only when its media element is active with the text track enabled and nobody has produced a render-time fetch from one; and an `srcset` mixing a `data:` candidate with a remote one loses the `data:` candidate, since the element is replaced. Both are documented in the docblock; neither can produce a silent fetch, only extra links.

Filed: **OW-kigole** (the CSP header) and **OW-rotuza** (`browser-testing` — the badge and link presentation are a first cut that no human has seen in a real browser, and jsdom cannot settle it).
