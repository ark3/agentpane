---
labels: [question, sweep-0929]
closed: done
---

# The session naming and marking stream predates the Both clients rule and specifies browser UI only, so it needs one plan for what a row carries and how both clients label it

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).

Five open cards are one question — what identifies a session's row — and all predate the owner's 2026-09-23 rule in `AGENTS.md` ("Both clients") that a user-facing capability lands in both clients or in neither:
- OW-jamaha, renaming an attached session from agentpane, written through to the backend;
- OW-muvili and OW-yilene, collecting names the rollout walk cannot see and reading Pi and Claude Code names from the store files the walk already opens (both blocked by OW-jamaha);
- OW-vezipo, a forked session's row being a copy of its parent's;
- OW-66, starring and hiding.
Each specifies browser UI and none names the Emacs picker.

Today `SessionSummary` in `src/shared/protocol.ts` carries only the walk-derived `preview`, and each client derives the row label on its own: `sessionLabel` in `src/client/App.svelte`, and the Preview column of `agentpane--session-entry` in `emacs/agentpane.el`, whose docstring already says it mirrors `sessionLabel`.

Some of these bodies have stale premises, found by the same sweep:
- OW-66 names `controller.onRename` as its escape hatch, and it no longer exists under `src/client`; it proposes a `notice` event, and `notice` is now the per-session notice on `ServerEvent`, whose docblock says D13's session-less arm is a different thing; and "no `writeFile` in `src/server`" is literally false (`src/server/http/app.ts` writes a temporary editor draft), though not agentpane state, so the spirit holds — `docs/DESIGN.md` repeats the claim.
- OW-jamaha was written before D24 and D25; its "the name shows only while attached" bites more now that D25 detaches everything on a stream drop.
- OW-vezipo notes the parent link (`forkedFrom`) is already on disk.

## Done when

One decision recorded in `docs/DESIGN.md`, extending D13 or as a new D-number, that names the `SessionSummary` fields a row carries (a name, D13's mark, and the fork parent), one label rule both clients follow, and where each field comes from.
Whatever it decides, each of the five cards is rewritten to it or closed, and each capability that survives has its Emacs card, labelled `emacs` and blocked by the wire card, per the Both clients rule.
OW-20 and OW-21 sit next to this (listing latency, which OW-yilene's done condition measures; and models, which OW-muvili offers to collect): say in the decision whether either changes.

## Close note

Decided with the owner on 2026-10-01 and recorded as D27 in `docs/DESIGN.md`.
`SessionSummary` gains `name` (read from the backend, never kept by agentpane), D13's `mark`, and `forkedFrom` (read from the session header). Both clients label a row by the name, then the preview, then the first user text, and a fork gets a marker that names its parent.
A choice beyond what the owner was asked, found by the adversarial read and flagged to them: marks follow `onDisk`, not `virtual`, because `#liveOverlay` reports a created session as `attached` before its first prompt, so no client can see that it is virtual.
OW-muvili, the Codex name collector, is deferred, because a listing-only `codex app-server` sits awkwardly with D25's "Only an attach starts an agent". OW-20 and OW-21 are unchanged.
The cards were restructured under "Both clients". OW-jamaha (rename), OW-66 (marks) and OW-vezipo (fork parent) became wire cards covering the HTTP API, `src/client/api.ts` and the Emacs helper's JSON-RPC. Each has a browser card and an `emacs` card blocked by it: OW-bumonu and OW-jidihu, OW-zewiru and OW-hahuna, and OW-galuhu and OW-kepemu, with the two marker cards also blocked by their client's label card. OW-yilene stays server-only. OW-ruyewe holds the deferred auto-hiding of forks.
The adversarial read also moved into OW-66 what fell between wire and client: a notice held and sent to each client at connect, every `event.handle` narrowing, and `sessions-changed` after a mark. It corrected OW-jamaha's Pi fake location and its vendored-method claim.
