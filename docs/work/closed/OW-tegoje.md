---
labels: [deferral]
closed: declined
---

# The Pi session list's one-line preview takes the first user message in the file, which may sit on a branch Pi abandoned

Filed 2026-10-15 by the execution of OW-gogoka, whose implementer noticed it; no file on either machine has been shown to hit it.

`parsePiSession` in `src/server/sessions/pi.ts` sets `SessionSummary.preview` from the first `type: "message"` user line with text, in file order, and stops there; it reads no `parentId`.
OW-gogoka made `extractPiPreviewTurns`, in the same file, draw only the branch from the file's last entry back by `parentId`, which its docblock records as the leaf `pi 1.2.0`'s `SessionManager` (`_buildIndex`, `buildSessionPath` in `dist/core/session-manager.js` under the global Bun install) takes for a loaded file.
So when a session's first user message was itself abandoned — the TUI re-editing it calls `resetLeaf()`, and the next entry is a new root with `parentId: null` — the list row shows the abandoned text while the preview and the attached session show the replacement.
A branch made later in the conversation does not reach the row, because the first user message stays on the path.

Deferred because the cost sits on the other side of the trade: `parsePiSession` runs once per file at enumeration, under the enumeration caps of `readLinesLfOnly`, and stops at the first hit, whereas finding the first user message on the leaf's branch needs the file's last entry, so the whole file.
OW-vezipo and OW-yilene also change what `parsePiSession` reads for the row; either may make this cheap to fold in.

## Done when

A test in `src/server/sessions/pi.test.ts` over a synthetic file whose first user message is abandoned for a second root asserts that `parsePiSession` returns the second root's text as `preview`, and fails against today's first-in-file read; or this card closes `--declined` with the cost reason recorded in its close note.

## Close note

Declined by the owner on 2026-10-31 in the card triage: no file on either machine has been shown to hit it, and finding the first user message on the leaf's branch means reading the whole file at enumeration, where today's read stops at the first hit under the enumeration caps.
