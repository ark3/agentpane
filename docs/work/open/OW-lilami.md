---
labels: [change, sweep-0929]
blocked-by: [OW-royosa, OW-vebeno]
---

# The browser clears a selection with nothing on disk only at detach() and a stream drop, and a gone session reached any other way strands an empty preview; clear it on the preview's gone instead

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`, point 6.
OW-royosa makes the preview answer `404` `gone` for a ref nothing holds and no file backs; this card makes that answer the one place the browser clears a selection whose session is gone, and removes the two places that guessed it before.
It absorbs OW-lejape and OW-tuyewo, both closed `--moot` into it on 2026-09-29; read them with `card show` for their orderings, which this card's tests drive.

## What to build

In `createController` in `src/client/controller.ts`, a preview read of the selected session answered `gone` clears the selection to the startup view, from each of the three paths that read it:
- `loadPreview`, the one fetch for a detached-loading pane (OW-forinu);
- `refetchPreview`, the self-refresh poll over a pane already on its preview, whose `catch` today swallows every failure, a 404 included, so a previewed session closed elsewhere or previewed across a server restart stays on an empty preview whose Attach can only 404;
- a row click, `preview(ref)`, which today calls `api.preview` itself, outside `previewLoads`, with no abort or bound, and can fire a second read beside `loadPreview`'s and report one failure in two places (OW-tuyewo).
  The click shares `loadPreview`'s read -- its `previewLoads` entry, abort and bound, and its reading of `gone` -- without its gates: `loadPreview` returns early while `previewHeld` is set or the stream is not `connected`, and its docblock names the click as one of the two things that ask a held read again, so a click still releases the hold and still reads while the stream reconnects, and the pane it leaves stays as it is until the read lands, as today.
  Where the click's failure reports, `previewFailure` or the error slot, is the implementer's call, in one place.
OW-bilogo's rule at `loadPreview`, "A failed read is never an answer", keeps its reasons and gains one exception keyed on the `code` `gone` of `ApiClientError` in `src/client/api.ts`, never on a transport failure or any other status.

## What goes

- `detach()`'s no-disk exit, which clears the selection and asks its own listing when the summary's `onDisk` is false.
- `onDisconnect`'s no-disk branch, which drops a row with nothing on disk and the selection with it.
- With them, the passages in those docblocks that cite OW-vasubu's empty-preview screen as the reason, `detachGapped`'s "Unlike `detach()`, this keeps a session with nothing on disk selected too", `followRef`'s in `src/client/session-state.ts`, which says `detach()` "finds the `onDisk` summary by ref", whatever OW-sodohi added to keep `detach()`'s no-preview promise, and `docs/DESIGN.md` D21's paragraph "It stays on the exit `detach()` takes for a session with nothing on disk", which D26 marks retired; rewrite it as history or delete it, and D25's "still clears one with nothing on disk" in its account of OW-forinu.

## What stays

The row with nothing on disk still stands in the sidebar until the next listing drops it; clicking it now reads `gone` and lands on the startup view, which is what makes the phantom harmless.
The selection intent rules: a read that lands after the user moved on does not clear anything (`selectionIntent`, as `refetchPreview` captures it).

## Done when

Tests in `src/client/controller.test.ts`, red first:
- OW-lejape's orderings: a `create` whose attach reply lands with `onDisk: false` across a stream drop and reconnect whose listing no longer names it, and another client's close of a selected session with nothing on disk with the stream up, each end with `state.selected === null` and no preview on screen;
- a selected session on its preview whose poll answers `gone` ends on the startup view;
- OW-tuyewo's: a click on the selected detached-loading row issues exactly one preview read, and a failure of it reports in exactly one place;
- `detach()` of a session whose summary claims `onDisk: true` but whose preview answers `gone` ends on the startup view, which its own exit, reading `onDisk`, could not do.
A read failing with any status other than `gone`, or with no response, still keeps the selection, as OW-bilogo's tests already pin.
`detach()`'s no-disk exit and `onDisconnect`'s no-disk branch are gone from the code.
`bun run check` passes, and so does `bun run test:browser`.
