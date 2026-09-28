---
labels: [defect]
---

# loadPreview decides whether a failed preview read is an answer with a stream-drop counter, which still clears the selection for a read that fails before the tab hears the drop or before an attach's snapshot; the rule should be replaced, not extended

Filed 2026-09-28 by the execution of OW-forinu under `card execute`'s rule for a check its adversarial read found added where the symptom showed, with cases it misses.

## Where it is

`loadPreview` in `src/client/controller.ts` is the one place that fetches a detached-loading pane's preview (OW-forinu; its docblock carries the reasoning).
Its failure branch treats a failed read as the server's answer and falls to the startup view, clearing the selection, which OW-forinu's card chose so that a server answering an error cannot drive a hot retry loop.
A read the outage cut is not an answer, so the branch asks again when `view.connection !== "connected"`, or when the `streamDrops` counter, bumped in `onDisconnect`, moved while the read was out; the counter's one reachable case is a read that hangs through the whole outage and fails after the reconnect.
The test "asks again for a preview whose read the stream dropped under, even when it fails after the reconnect" in `src/client/controller.test.ts` pins it.

## What it misses

Proved by probe in the adversarial read, 2026-09-28:

- A read that fails as the server exits, before the tab has heard the stream drop, counts as an answer and clears the selection; the docblock admits it. Not a regression: `main` before OW-forinu cleared every selection at a drop.
- Stream up, `select`, the attach reply beats its snapshot (D2), the pane is detached-loading and its read fails before the snapshot lands: the selection is cleared and the live view then arrives unselected.
- A read that never settles keeps its key in `previewLoads` for good, so that session sits on the loading pane with no further fetch, across drops and reconnects too.

## The change

Replace the rule deciding what a failed read means rather than adding a case for each of these.
One candidate, not settled: a failed read never clears the selection, and the pane stays detached-loading and asks again only at the next transition to `connected`, which is what keeps it from looping; the cost is a pane that says nothing while a server keeps answering an error, and whether an error line is owed then is this card's call.
The hung read needs a bound of its own whatever is chosen; `api.preview` in `src/client/api.ts` takes no signal today.

## Done when

Tests in `src/client/controller.test.ts`, each red first: the three orderings above end with the selection standing (and, for the second, live once the snapshot lands), and a read that never settles does not stop a later `connected` from fetching.
The `streamDrops` counter is gone, and the test named above is rewritten to the new rule rather than deleted.
`bun run check` passes.
