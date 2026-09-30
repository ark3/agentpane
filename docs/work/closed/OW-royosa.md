---
labels: [change, sweep-0929]
blocked-by: [OW-kamave]
closed: done
---

# The preview route answers an empty transcript for a ref nobody holds and no file backs, so gone and not-yet-written read alike; answer 404 gone there

Filed 2026-09-29 by OW-zavehi, whose decision is D26 in `docs/DESIGN.md`, point 5.
This card carries the answer onto both wires; the browser's selection and agentpane-mode's buffer at `gone` are their own cards, blocked by this one.

## What is there now

The `preview` case of `sessionAction` in `src/server/http/app.ts` reads `deps.index.preview(ref)` and "deliberately never touches `sessions`" (OW-38).
`SessionIndex.preview` in `src/server/http/deps.ts` answers `SessionPreviewTurn[]`; production wires it in `src/server/composition.ts` to `readSessionPreview` in `src/server/sessions/preview.ts`, which returns `[]` both for a ref whose file it cannot find, on all three backends, and for a file with no turns.
`emptySessionIndex` in `src/server/http/deps.ts` and the fake index in `src/server/http/testing/fakes.ts` share that shape.
`SessionManager` in `src/server/http/session-manager.ts` has no way to say it holds a ref across the table, the parked forks (`#pendingForks`) and a startup at its index lookup (`#attaching`); `summaryOf` and `isAttached` see the table alone.

## What to build

- The route answers `404` with the error code `gone` when the manager holds nothing under that name and then the index finds no file.
  `gone`, not `not_found`: `notFound()` in `app.ts` answers an unmatched route with `not_found`, and so does `UnknownSessionError`, so a route mismatch must not read as a session ending.
  The manager is asked first; D26 point 5 says why the other order can report a session whose file appeared mid-read as gone.
- "Holds" counts the table, parked forks and startups in flight, and not a close still disposing (`#disposing`).
  It is one question with one answer, and OW-kamave, which this card waits on, decides which record owns a startup in flight; ask that owner rather than walking the records one by one.
  OW-kamave may close on its decision and file the cards that build it; its body says to add the one that builds the owner to this card's blockers, and if it has not, check before starting that the owner exists in the code.
- The index seam gains a distinct answer for no file, for example `null` from `SessionIndex.preview`, carried through `readSessionPreview`, `emptySessionIndex` and the fake index.
  The fake's default for a ref with no canned preview stays an empty transcript, so the app tests that preview unheld refs today keep their meaning; a test that wants no file says so.
- The Emacs wire: the helper passes an HTTP error through as `{ status, error, detail }` in the JSON-RPC error's `data` (the error paragraph in `src/emacs/protocol.ts`), so `sessions/preview` should already carry `gone`; a test in `src/emacs/helper.test.ts` pins it.
- The client's `ApiClientError` in `src/client/api.ts` carries `status` and `code`; nothing in the browser reads `gone` yet, which is the next card's.

## Records that change with it

The route's OW-38 comment, `SessionIndex.preview`'s docblock, `readSessionPreview`'s "the preview is empty rather than an error", and the `sessions/preview` entry in `src/emacs/protocol.ts`, which says it can answer an error carrying `gone`.

## Done when

Red first, in the app's tests under `src/server/http/` and the preview's tests under `src/server/sessions/`:
- a preview of a ref the manager does not hold and no file backs answers `404` `gone`;
- `readSessionPreview` tells a missing file from a file with no turns, on each backend.
Pins, which pass today and must still pass: a virtual session before its first prompt, a parked fork before its attach, and an attached session with nothing on disk yet each answer `200` with no turns, the parked fork showing that "holds" reaches past the table; an unmatched session action still answers `not_found`; and in `src/emacs/helper.test.ts`, `sessions/preview` for a gone ref is answered with an error whose `data` carries `gone`.
`bun run check` passes.

## Close note

Built and landed on main (d357aad, 7c6eccb, 8058693, b296b94).

The preview route (`sessionAction`'s `preview` case in src/server/http/app.ts) asks `SessionManager.holds(ref)` first, then the index, and answers 404 `gone` when nothing holds the ref and the index answers null; otherwise 200 with `turns ?? []`. `holds` is D24's answer: a name in `#names`, an entry in `#attaching` (which `#retire` deletes once empty), or `#pendingForks`; not `#disposing`. `SessionIndex.preview` now answers `SessionPreviewTurn[] | null`, null for no file, through `readSessionPreview` (Pi path not resolving inside the store, no filename match on Claude or Codex), `emptySessionIndex`, and the fake index, whose `previews` map takes null to say "no file" and still defaults to an empty transcript. Records updated: the route's OW-38 comment, the `SessionIndex.preview` and `readSessionPreview` docblocks, the `sessions/preview` entry in src/emacs/protocol.ts, D26 point 5's "answers only turns today", D21's no-disk-exit sentence, and the comment on the no-disk exit in src/client/controller.ts. No client behaviour changed.

Verified: the app test for 404 gone and the three held-with-no-file pins (virtual before first prompt, attached with nothing on disk, parked fork before attach), each made to tell the fake index "no file" so `holds` does the work, went red against the old route (re-confirmed in review). The four no-file cases in src/server/sessions/preview.test.ts went red on `[]`; file-with-no-turns pins per backend pass. session-manager.test.ts covers `holds` for the table, a startup mid-lookup, a parked fork, and a close still disposing (red with `holds` reading `#names` alone, and with it counting `#disposing`). The unmatched-route test now asserts `not_found`; helper.test.ts pins `gone` in the JSON-RPC error's data. bun run check green: 1537 tests.

Adversarial read found no wrong answer beyond D26's accepted "one stale empty preview", plus one narrow divergence, not filed: with a close still disposing a container renamed from V to an on-disk B, preview(V) answers gone while an attach(V) sent in that window resumes B; once the disposal ends attach(V) throws UnknownSessionError, so gone is the steady-state answer anyway and clients carry the new ref from events. It also noted, unverified, that `#forkOnto`'s docblock calls a Pi fork's parent "still on disk", which may not hold for a fork in its first turn. Interim effect until D26 points 6 and 7 land: a browser row click on a gone no-disk session now surfaces the 404 as an error rather than an empty preview, and agentpane-mode's `g` on one gets a JSON-RPC error.
