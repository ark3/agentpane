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
