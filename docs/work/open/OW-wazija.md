---
labels: [deferral]
---

# A browser attach whose reply lands after the event stream drops re-selects a live session with no view, putting back the composer OW-fiheli took down

Found 2026-09-28 by the adversarial read of OW-fiheli, by reading only; not reproduced.
In service of D25 in `docs/DESIGN.md`, point 3: a client whose event stream drops holds nothing live.

## What happens

OW-fiheli made `onDisconnect` in `src/client/controller.ts` drop every live view, flip the sidebar's held summaries to detached, and clear a selection that has no preview.
It deliberately does not bump `selectionIntent`: its docblock says a gesture still in flight "settles on its own, failing against a dead server or landing on a live one", and a bump would strand `busy` on `"attaching"` (the `finally` block of `attachAndSelect` resets `busy` only while the intent is unchanged).
That misses an attach the server answered just before it exited, where the tab handles the stream's error before the fetch's reply.
`attachAndSelect`, and `create` through it, then calls `applyAttached(..., true)`: the session is selected with no view (its snapshot died with the stream), the preview is cleared, and an `attached` summary is written — the composer OW-fiheli exists to remove, whose Send meets a dead server.
`forkAndSubmit` does the same with the fork, since its `takesSelection` still reads true.
A `recover` in flight across the drop only relights its row's summary as attached; it never moves the selection (and OW-lunihe retires recovery by attach anyway).

Mitigation, from the HTML spec and not measured: `EventSource` fires `error` again on every failed reconnection attempt, and a fatal close is rebuilt by `scheduleReconnect`, so `onDisconnect` likely runs again within seconds and clears the selection again; the `attached` summary it wrote would stand until the reconnect's listing.

## What is load-bearing

No path leaves the tab, while `view.connection` is `"reconnecting"`, with a selected session that has neither a live view nor a preview, or a summary reading attached.
Where the fix lives is open: one reading is that `applyAttached` refuses to select while the stream is down (it is the owner of the attach's landing, rather than a guard at each gesture), another is that the drop bumps the intent and `attachAndSelect`'s `finally` stops keying `busy` on it.
Whichever it is, it must not strand `busy`.

## Done when

A test in `src/client/controller.test.ts`, red first, starts `controller.select(ref)` with `api.attach` held, drops the stream, resolves the attach, and asserts `view.state.selected` offers no send (`submit()` issues no `api.prompt`), no summary reads `attached`, and `view.busy` is back to `"idle"`.
The same holds for `create` and for `forkAndSubmit`.
`bun run check` passes.
