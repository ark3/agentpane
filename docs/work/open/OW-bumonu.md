---
labels: [change]
blocked-by: [OW-jamaha]
---

# The browser offers no control to rename an attached session, and its row label does not put a session's name before its preview (D27)

`src/client/App.svelte` (the Tools popover, `<div id="tools-menu" popover ...>`, and `sessionLabel`), `src/client/controller.ts` (`setModel` is the sibling for the call; OW-jamaha adds `setName` to `src/client/api.ts`), `src/client/App.test.ts`.

The browser half of renaming, under `docs/DESIGN.md` D27 and the "Names are not marks" paragraph of D13.
OW-jamaha puts the rename on the wire and `name` on `SessionSummary`; this card is the control and the label.
Its Emacs twin is filed beside it, blocked by the same card, per `AGENTS.md`, "Both clients".

## What has to exist

- A Tools menu item that renames the selected session, enabled only while that session is attached and not mid-turn, gated the way New conversation and Compact beside it are `disabled`, and reachable by pointer (D14).
  The owner chose the Tools popover on 2026-09-15, beside New conversation and Compact, which are already gated on a selected session.
  Whether it opens an inline edit of the row or a prompt is a first cut, and either has a visible way out (D14).
- `sessionLabel` follows D27's rule: the name, then the preview, then the first user text of the loaded transcript, then backend and id.
  Its docblock says so, and that the Emacs picker follows the same rule.

Load-bearing: no control on a detached or mid-turn session, and the label order.
Incidental: the edit's shape, and how an empty name reads, which follows whatever OW-jamaha's close note chose.

## Done when

Each watched red first, in `src/client/App.test.ts`:

1. The Tools menu item is unavailable for a detached session and for one mid-turn, and available for an attached idle one; using it calls the rename with the typed name.
2. A row whose summary carries a name renders the name, and one whose name is null renders the preview.

`bun run check` passes.
