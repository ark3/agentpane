---
labels: [deferral]
---

# The Attach button does not focus the prompt when the attach reply beats its snapshot, since no composer is drawn yet

Found by the adversarial read of OW-forinu on 2026-09-28, by reading; not reproduced.
Deferred because it needs the reply-before-snapshot ordering D2 allows, which the server makes rare by broadcasting the snapshot before it replies (`paneMode`'s docblock in `src/client/controller.ts`), and its cost is one click into the prompt.

`attachSelected` in `src/client/App.svelte` awaits `controller.select(ref)`, then `tick()`, then focuses the prompt textarea.
Since OW-forinu the composer is drawn only in the live mode (`paneMode`), so when the reply beats the snapshot the textarea does not exist yet at that focus, and the composer then appears without focus; before OW-forinu the composer was drawn at the reply.
The App test's `FakeController.select` in `src/client/App.test.ts` models only the snapshot-first ordering, so nothing covers this.

Done when a test in `src/client/App.test.ts`, red first, has the fake's attach resolve before the view appears and finds the prompt focused once it does; `bun run check` passes.
