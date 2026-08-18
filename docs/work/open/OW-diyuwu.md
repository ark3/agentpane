---
kind: change
where: '`public/favicon.svg` (OW-ropuwo), `src/client/` wherever the summary list is held'
---

# A tab cannot show that an agent is blocked waiting on you, which is the one thing worth glancing at a tab for.

Depends on `OW-ropuwo`, which draws the base icon. This overlays a coloured dot
on it and repaints it as state changes, so a backgrounded tab reports whether
anything wants the human.

The state that earns this is D2a's `ServerRequest`: "the agent is asking the
human something and is blocked until answered" (`src/shared/protocol.ts`, and
`resources/fixtures/codex/tool-edit.jsonl` for a real
`item/fileChange/requestApproval`). An unanswered one hangs the turn, so a
session can sit blocked indefinitely with nothing on screen if the tab is not
frontmost. `SessionSummary.isStreaming` is the weaker second signal — useful,
but nobody needs a tab badge to learn that a model is still typing.

## The question this item has to answer first

The favicon is per-tab and the app holds *every* session (`SessionSummary[]`,
`status: "virtual" | "detached" | "attached"`), so the dot has to aggregate.
The proposal is that it reports **any** session blocked on a `ServerRequest`,
not the focused one — a badge that goes quiet because you navigated away from
the blocked session is worse than none. Settle that before drawing anything;
if it lands the other way, most of the rest of this item changes.

Colour follows the existing tokens rather than inventing any: `--ap-warning`
or `--ap-accent` for blocked, `--ap-success` for streaming, if those read at
badge size (`src/client/app.css`).

## How it is drawn

A favicon repaints by swapping the `href` on the `<link rel="icon">`, so the
dot means generating the SVG (or a canvas-rendered PNG) at runtime rather than
shipping one static file. Whether a data-URI SVG is enough or it needs a
canvas is unsettled and worth a probe before committing to either — Chrome and
Firefox have historically differed on animated and dynamically-swapped SVG
icons, so verify against both rather than assuming.

## Done looks like

`bun run test:browser` drives a session into a pending `ServerRequest` and
asserts the `<link rel="icon">` href changed, then asserts it reverts once the
request is answered. Plus a screenshot of the tab in both states — whether a
dot is *noticeable* at 16px is a verdict from use, not an assertion.
