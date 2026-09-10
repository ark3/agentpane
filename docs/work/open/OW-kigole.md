---
labels: [change, now]
---

# agentpane serves no Content-Security-Policy, so the sanitizer is the only thing standing between a hostile transcript and an outbound request

`src/server/http/static.ts` (the HTML response path), `src/client/render/markdown.ts` (`sanitize`), `docs/DESIGN.md` D5 and D8.

`grep -rni "content-security-policy"` over `src/`, `public/`, `e2e/` and `docs/` is empty: nothing sets the header, and no card or decision has ever considered it.

D5's amendment records the decision that remote media renders as a link rather than loading — and that decision is enforced entirely in `sanitize()`, one DOMPurify hook in one file.
That is the *semantic* half and it is the right place for it, because only the renderer can turn a blocked image into something a reader can click.
But it is also the only half, and it fails open in a way nobody would notice: a DOMPurify upgrade that widens the default profile, a new media element, or any future `{@html}` sink added without going through `sanitize()` reopens the channel silently, and the failure is invisible by construction — a beacon fires successfully and looks exactly like nothing happening.

A `Content-Security-Policy` on the served HTML is the boundary the renderer cannot be: it is enforced by the browser, applies to every element on the page whatever produced it, and covers vectors that were never enumerated.
The probe behind OW-holabo found `<img srcset>`, `<video poster>`, `<audio src>`, `<picture><source srcset>` and protocol-relative `//host/x.png` all reaching the page, which is the shape of the problem — the list is only as good as whoever last thought about it.

**Scope it narrowly.**
`img-src 'self' data:; media-src 'self' data:` restricts exactly the two fetch classes at issue and names no other directive, so scripts, styles, fonts and connections are untouched and nothing that works today stops working.
Resist widening it to `default-src` in the same change: that is a different decision with a real chance of breaking the app, and it deserves its own card and its own evidence.
`data:` stays allowed because agent-generated images arrive that way and have no network side (OW-kehose).

Being loopback-only (D8) is not an argument against this.
D8 bounds who can reach the server; it says nothing about where the page can send a request once hostile content is rendered into it, which is the direction that matters here.

## Done when

- The HTML response carries the header, set where the served document is built in `src/server/http/static.ts`.
- A server test asserts the header is present on the HTML response with the two directives, and asserts it is *absent* or harmless on non-HTML responses if that is how it is implemented; it fails before the change.
- A browser check confirms the app still works with the header live — `bun run test:browser`, which is the vehicle for anything jsdom cannot see, and jsdom does not enforce CSP at all. Label `browser-testing` applies if that turns out to need a human eye rather than the Playwright run.
- A remote image in a transcript is observably blocked by the browser with the sanitizer's link fallback removed for the length of the check, proving the header alone stops it. Restore the fallback afterwards; the two are meant to overlap.
