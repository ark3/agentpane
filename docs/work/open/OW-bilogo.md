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

Decided by the owner on 2026-09-28.

A failed preview read is never an answer.
The pane stays detached-loading and the selection stands; nothing in `loadPreview` clears it.
What keeps a failing server from driving a hot loop is when the read is asked again: only at the next transition of `view.connection` to `connected`, or when the user selects the row again, and never from the failure branch itself.
With that rule the `streamDrops` counter goes, and the first two orderings above need nothing of their own: the selection stands, and in the second the snapshot makes the pane live when it lands.

A read has a bound: `api.preview` in `src/client/api.ts` takes an abort signal, and `loadPreview` aborts a read that has not settled within a timeout, which then counts as a failed read under the rule above and frees its `previewLoads` key.
The timeout's value is a first cut, about 10s for a read of local disk, named as a constant beside the other timings in the controller; nothing has measured a slow preview.

A read that failed while the stream is up puts one line in the pane, "Couldn't load the transcript: " followed by the failure's message, above the Attach button, and not in the global error slot, which a background read with no gesture behind it does not own.
The owner chose the line over silence on 2026-09-28: the empty loading pane is honest while the server is down, and would hide a server answering errors while it is up.
The line clears when a read for that session succeeds or the selection moves.
Whether it lives on `ControllerView` or beside the preview state is the implementer's call.

## Done when

Tests in `src/client/controller.test.ts`, each red first:

- A read that fails before the tab hears the stream drop leaves the selection standing, and a read goes out again at the next `connected`.
- `select` whose attach reply beats its snapshot, with the preview read failing before the snapshot lands: the selection stands, and the pane is live once the snapshot lands.
- A read that never settles is aborted at the timeout (driven with fake timers), and a later `connected` fetches again.
- A read that fails with the stream up issues no further read until a `connected` transition or a re-select, and sets the pane's failure line, which a later successful read clears.

The test "asks again for a preview whose read the stream dropped under, even when it fails after the reconnect" is rewritten to the new rule rather than deleted, and the `streamDrops` counter is gone.
A test on `src/client/App.svelte` shows the failure line over the Attach button.
`bun run check` passes, and `bun run test:browser` passes, since the line changes what the composer's action row area draws (`AGENTS.md`).
