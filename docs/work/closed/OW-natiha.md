---
labels: [defect, browser-testing]
blocked-by: [OW-jelovu]
---

# Compaction feedback ends at request admission, leaving a live backend operation invisible until its transcript marker arrives.

`src/client/controller.ts` (`ControllerView.busy` and `compact`), `src/client/session-state.ts` (where `snapshot` and `status` events land), and `src/client/App.svelte` (`status`, `streamingNow`, and `.prompt-actions`) are the starting points.
OW-72 established the eventual `compactionSummary` transcript marker, and OW-81 added request-scoped `busy === "compacting"` feedback.
The owner now observes that the OW-81 status is gone after request admission and before the marker arrives, so the successful click still feels like a no-op during the backend work.

## The server half

OW-jelovu is the server half of this work, split out on 2026-09-01, and this card is blocked on it.
It carries the settled `AdapterState` shape and puts `compaction: "requesting" | "running" | null` on the `snapshot` and `status` arms of `ServerEvent`, which is the truth this card renders.
Consume that field rather than the lifetime of `api.compact()`: the state is per session, survives reconnection through snapshots, and enters at `running` with no requesting phase when a backend compacts on its own.
An auto-compaction shows the status too, because blocking Send without showing why would be a dead composer, which is worse than the defect this card fixes.

## Precedence over isStreaming

Compaction is not a user-stoppable generation turn, but Codex and Claude expose it through generic active-turn signals, so `isStreaming` stays true on the wire during their compactions and the composer offers `Stop` and `Stop and edit` today; the reducers keep reporting that wire truth, settled 2026-09-01 with the reasoning in OW-jelovu.
While `compaction` is non-null the action row therefore gives it precedence: show the compacting status and no Stop control, whatever `isStreaming` says.

## What the user sees

Keep a persistent status beside the control that initiated the operation in `.prompt-actions`, such as `Compaction requested…` followed by `Compacting context…`, until the marker or error arrives.
Expose the changing text as an accessible live status.
The exact wording and whether it uses a spinner are incidental, but it must remain visible after the Tools popover closes and must not require looking at the masthead.
Disable another Compact and prevent Send, Fork, and their keyboard paths from starting work in that session while compaction is requesting or running, since the backends cannot safely admit a concurrent turn.
Do not add a cancel or Stop affordance for compaction.
Keep Tools usable if doing so is useful for New conversation; only the conflicting actions are load-bearing.

## Done when

A controller test resolves `api.compact()` before any backend lifecycle update and asserts that the selected session still reads as compacting until a terminal server event arrives.
An `App.test.ts` test asserts that the composer acknowledgment survives request resolution, Compact and Send or Fork cannot fire during it, no compaction Stop control appears, and the acknowledgment clears when the marker-backed terminal update arrives.
The behavior-changing tests are watched red against the current request-scoped implementation before the fix.
Because this changes the composer action row, `bun run test:browser` covers its visible placement without horizontal overflow and is run locally alongside `bun run check`.

Implemented in e0bbc16 (composer half) and 09b3132 (review fix): the composer now renders the per-session `compaction` field the server feeds over `snapshot` and `status`, so the acknowledgment survives request admission, reconnection, and backend-initiated compactions.
A `role="status"` live text ("Compaction requested…" then "Compacting context…") sits beside Tools in `.prompt-actions` until the marker-backed terminal update or error clears it; Compact, Send, Fork, and their keyboard paths cannot start work while compaction is requesting or running; and compaction takes precedence over `isStreaming`, so no Stop, "Stop and edit", or "Stop and fork" control appears during one.
The controller marks the selected session "requesting" at the click, clears it only on a rejected POST — through a D9 rename tracker, after the adversarial review caught the click-time key going stale mid-flight — and otherwise lets server events own the field.
Verified by two controller tests, three App tests, and a new e2e spec (popover-close survival, placement beside Tools, zero horizontal overflow), every behavior-changing one watched red first; `bun run check` (886 tests) and `bun run test:browser` (12 specs) green on main after landing.
An implementation finding: a menu button disabled synchronously in its own click skips its declarative `popovertarget` hide in Chromium, so `compactSession` closes the Tools popover by hand — the why is in its docblock.
Two accepted residual races around the optimistic requesting mark are OW-husivu.
