---
labels: [change]
blocked-by: [OW-66]
---

# The browser can neither star nor hide a session, nor show the server's session-less notice (D13, D27)

`src/client/App.svelte` (the `<nav class="sessions">` list and its sort-and-filter deriveds), `src/client/controller.ts` (OW-66 adds the mark method to `src/client/api.ts`), `src/client/App.test.ts`.

The browser half of marks, under `docs/DESIGN.md` D13 and D27.
OW-66 builds the server's store, the route, `mark` on `SessionSummary`, and the session-less notice arm on `ServerEvent` that reports a corrupt store; this card draws them.
Its Emacs twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

## What has to exist

- A control on a row to star it, hide it, or return it to normal, reachable by pointer (D14), and absent on a session whose `onDisk` is false, the rule D27 and OW-66 take for D13's ban on marking a virtual session.
  A row is one `<button class="session-select">` today, so the control cannot nest inside it and the row's markup changes.
- The client filters, as D13 decides: a hidden row is absent from the list unless a "show hidden" control is on, and a starred row is drawn distinctly.
- The session-less notice, which OW-66 has the shared reducer hold, is rendered somewhere other than the per-session `view.error` banner.

Incidental, decide in flight and say in the close note: whether starred rows float to the top or are only drawn distinctly, where "show hidden" sits, and the notice's wording.

## Done when

Each watched red first, in `src/client/App.test.ts`:

1. A hidden session is absent from the rendered list and present once hidden sessions are shown.
2. A row whose `onDisk` is false offers no mark control.
3. The session-less notice renders outside `view.error`, and a later session snapshot leaves it standing; assert on structure, not wording.

`bun run check` passes.
