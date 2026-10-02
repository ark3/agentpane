---
labels: [change, d27]
blocked-by: [OW-jamaha]
closed: done
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

## Close note

Landed 2026-10-02 in two commits on main: "client: rename an attached session from the Tools menu, and label a row by its name first (OW-bumonu)" and the review follow-up "client: assert Rename on a session with a transcript, and say what its gate leaves open (OW-bumonu)".

Built: a Rename item in the Tools popover between Compact and Detach, gated by `renamable` in `src/client/App.svelte` -- Detach's predicate (live `streamingNow`, `view.sending`, `compaction`) with `status === "attached"` alone, because `virtual` is reported only for a session with no adapter (`SessionManager.#liveOverlay`) and the name route 409s on `!isAttached`. The edit is `window.prompt` as a first cut, pre-filled with the current name or empty (never the preview, which OK would then save as a name); Cancel and a name blank once trimmed send nothing, and the route normalises the rest. `controller.setName` writes through `api.setName` and keeps no copy; the name comes back on the listing `sessions-changed` brings. `sessionLabel` is now name, preview, first user text, backend and id, and its docblock states D27's rule and that the Emacs picker follows it short of the last step (OW-jidihu makes agentpane-mode do so).

Gated mid-turn, open before the first turn, as the route is; neither was ever measured for Claude or Codex. OW-kametu holds that, amended here so its route change carries the browser gate with it, and to record that `window.prompt` blocks the page so a turn started elsewhere while the dialog is open still lets a mid-turn POST through -- only the route can refuse that.

Verified: three App.test.ts tests written first and watched red; the gate test then broken by each conjunct in turn (virtual allowed, attached dropped, streaming dropped, listing isStreaming instead of live, sending dropped, compaction dropped) and red each time; the rename test drives the real controller to the API's `setName` and goes red on sending a blank name or on Cancel; review added a non-empty-transcript case, watched red against a gate that copied `setModel`'s empty-transcript condition. `bun run check` green, 1629 tests, 36.9s; `bun run test:browser` 26 passed, none of which exercises Rename. Not observed in a real browser: whether the Tools popover stays drawn behind the prompt while it is open.
