---
labels: [defect]
---

# The composer sends the same prompt twice on a second Ctrl-Enter during the round trip, and discards anything typed while it waits

`src/client/controller.ts`, `submit()`: the only guards are a selected session and a non-empty `view.draft`; `busy` is not consulted.
`src/client/App.svelte`, `send()`: guards on `compaction` and the draft, then calls `controller.submit()`.
The draft is cleared only on success, in the `publish({ draft: "", state })` after `api.prompt` resolves.
So a second Ctrl-Enter, or Enter followed by a click on Send, while the first POST is in flight issues a second identical `POST prompt`.
The server does not reject a second prompt on a streaming session (the only 409 in `src/server/http/app.ts` is `not_attached`), so what happens next depends on the backend, which is OW-rifezo's question.

The same `publish({ draft: "" })` is unconditional, and the textarea (`aria-label="Prompt"` in `App.svelte`) is never disabled while `busy === "submitting"`.
Anything typed between Send and the response is wiped when the response lands.
Clear the draft only if it still equals the text that was sent.

`controller.test.ts`, "clears the draft only after the prompt is accepted", exercises neither the second submit nor typing during the wait.

## Done when

- A test in `controller.test.ts` calls `submit()` twice while the fake API's prompt promise is held open and asserts one request; it fails before the change.
- A test publishes a new draft while the promise is held, resolves it, and asserts the new draft survives; it fails before the change.
- `App.test.ts` covers the Ctrl-Enter path once, since `send()` is where the keyboard reaches it.
