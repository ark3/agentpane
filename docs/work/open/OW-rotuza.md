---
labels: [change, browser-testing]
---

# Nobody has looked at the remote-media link badge in a real browser, and its shape was a first cut

`src/client/render/Markdown.svelte` — the `.ap-remote-media::before` rule; `src/client/render/markdown.ts`, `linkRemoteMedia`; `e2e/`.

OW-holabo replaced remote media with a badged span of links, and every check behind its appearance is jsdom, which has no layout and draws nothing.
`bun run test:browser` passes but has no case for this at all — the 20 specs predate it.
The implementer marked the styling a first cut and said the verdict has to come from looking at it, which is this repo's usual shape for a UI guess.

What was guessed, all of it in one CSS rule and one function:

- The badge is a `::before` printing `attr(data-media)` at `0.75em`, uppercase, `0.05em` letter-spacing, in `--ap-fg-muted`. Whether that reads as a label or as noise in front of the link is the question.
- The badge word for a `<source>` is the generic `"media"`, because a bare `<source>` does not say what it is. In a `<video>` the reader sees `VIDEO` then `MEDIA` nested inside it, which may read as two things when it is one.
- Link text is the full URL when `alt` is empty, with no truncation, wrapping via `overflow-wrap: anywhere`. That was chosen so the reader can judge the host rather than see a tidy stub — a long URL in a narrow column is the case to look at.
- Multiple URLs (a `<video>` with `poster`, or an `srcset`) become several links separated by a space, inline. Whether that reads as a list or as a run-on is unknown.

## Done when

A human has opened a transcript containing each of these in a real browser and said whether it reads correctly, and the verdict is recorded — either the styling stands, or it changes and the reason is in the commit.
The cases worth putting in front of an eye: an image with empty `alt` and a long URL; an image with `alt`; a `<video>` with `poster` and a nested `<source>`; and an `srcset` with several candidates.

Do not settle this by adding a jsdom test.
It cannot see any of it, which is the whole reason this card exists.
An `e2e/` spec asserting the badge's text and that the links are present is worth adding while someone is in there, but it is not the verdict either.
