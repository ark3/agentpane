---
labels: [deferral]
closed: moot
---

# Clicking a selected row whose pane is detached-loading reads its preview outside loadPreview, so it can fire two reads and report one failure in two places

Filed 2026-09-29 by the execution of OW-bilogo, from its adversarial read.

## Where it is

A click on a sidebar row goes through `preview(ref)` on the controller returned by `createController` in `src/client/controller.ts`, which calls `api.preview(ref)` itself, with no entry in `previewLoads`, no abort signal and no `PREVIEW_READ_TIMEOUT_MS` bound, and reports a failure in the global error slot because a gesture stands behind it.
`loadPreview` in the same file is the background read for a detached-loading pane; since OW-bilogo a failed one keeps the selection, holds further background reads (`previewHeld`) until the next `connected`, and writes `previewFailure` on the view, which `src/client/App.svelte` draws above the Attach button as "Couldn't load the transcript: …".

## What it does

- Clicking the selected row while its pane is loading and not held: `preview()` publishes `{ error: null }`, whose `publish` calls `loadPreview`, so two reads of the same preview go out. This predated OW-bilogo, but a failed read now keeps the selection, so the loading pane is easier to click on.
- Clicking it while held, with the click's read failing too: the pane's line keeps the first failure's message and the error slot shows the second's, for the same session. Proved by probe P5 in OW-bilogo's adversarial read.

Neither loses data or stalls the pane; it is judged not worth blocking OW-bilogo on.

## Done when

A test in `src/client/controller.test.ts`, red first, shows a click on a selected detached-loading row issues exactly one preview read, and one that a failure of that read reports in exactly one place.
Which place, and whether the click should go through `loadPreview` rather than its own fetch, is the implementer's call; the owner's rule from OW-bilogo, that a failed read is never an answer and the selection stands, still binds.

## Close note

Folded 2026-09-29 into OW-lilami by OW-zavehi's decision, D26 in `docs/DESIGN.md`, point 6, which routes a row click's preview read through `loadPreview` so that a `gone` answer is read in one place.
OW-lilami's done-condition carries this card's two tests: one read per click on a selected detached-loading row, and one place its failure reports.
OW-bilogo's rule that a failed read is never an answer still binds, with the one exception D26 makes for `gone`.
