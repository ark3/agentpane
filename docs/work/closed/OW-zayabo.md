---
labels: [question, now]
closed: moot
---

# GitHub Issues should become agentpane's tracker of record, with card kept for decomposing and implementing one issue at a time

Agreed in direction by the owner on 2026-10-23, continuing the project survey of 2026-10-15 (Claude Code session `85e5c4a6-7786-4cd5-abca-7e0ca5dceef7` on the home server).
Some discussion remains, so this card holds the plan as agreed so far and closes when the decision is recorded.

## Why

The owner's judgment, 2026-10-23: card is a poor issue tracker, with almost no affordances for the owner to manage issues, and an excellent mechanism for turning one issue into cards and then a reviewed implementation, with the owner involved only at the beginning and the end.
`card author` was written for that mode: "Larger work arrives as a ticket, or as a planning document standing in for one. Decompose it into cards, each carrying the ticket's key as a label."
This repo instead runs the deck as the tracker of record with nothing above it, so nothing gates what a review files.
Measured on 2026-10-23: 93 open cards, of which 41 are `deferral`, 20 `change`, 19 `defect`, 7 `unverified` and 6 `question`; 56 say in their opening lines that another card's review, implementer report, survey or run filed them.
Between 2026-09-23 and 2026-10-15, 275 cards closed and 281 were filed.

## The plan as agreed

1. Do not promote every open card.
   Seed GitHub with a handful of outcome-level issues (below), plus the open cards that came from the owner's own use or asks, such as OW-66 and OW-taweso.
   Then triage the open deck once: a card that belongs to an issue is cited there and closed `--promoted` with the issue's URL in its close note, and the rest close `--declined` as not seen in use, which keeps their reasoning greppable in the closed pile.
   A dispatched reader can draft the triage table (card, proposed issue or decline, one-line reason) for the owner to approve in one sitting.
   Considered and not chosen: promoting everything and triaging in GitHub, which seeds the new tracker with the old one's output; and closing the whole open deck `--moot` under one note.
2. Settle three mechanics before the first promotion.
   - `card workflow` reserves `--promoted` for "an outside system the project answers to but does not control" and says it never applies on a deck with no such system beside it; `AGENTS.md`, "Cards", has to name GitHub Issues as that system, or a session following the contract will refuse the flag.
   - A blocker closed `--promoted` makes its dependents look ready, so promote a stream whole: the open D27 wire cards together with the client cards they block.
   - `gh` is not logged in on the home server as of 2026-10-23, so no session can read or file issues; a fine-grained token scoped to this repository's issues keeps the blast radius small, since every sandboxed agent can read what its session can.
3. A finding that surfaces mid-work and lies outside the current issue becomes a GitHub issue labelled `triage`, or a comment on the current issue, and never a card on the executable deck, so the owner is the gate between a finding and work.
   GitHub supplies what the deck could not: Projects for order (`AGENTS.md` records the `sweep-0929` order by hand because "a label cannot carry it"), sub-issues for streams, blocked-by links, and the mobile app for triage away from a desk.
   The label-stream paragraphs in `AGENTS.md`, "Labels", can go once their streams are issues.
4. One finding from the 2026-10-15 survey is security-sensitive and stays out of every public record, this card included, until it is fixed: fix it first, or file it as a private GitHub security advisory.
   The owner has it, and the home server's agent memory holds it as `agentpane-unpublished-security-finding`.

## Seed issues

Each comes from the 2026-10-15 survey, with what a cold session needs to file it.

- A misbehaving backend never takes down the server or strands a session.
  `emitLine` in `src/server/adapters/child-process.ts` calls every adapter's line handler unguarded, nothing in `src/` handles `uncaughtException`, and the Codex reducer dereferences fields such as `message.params.turn.id` unchecked (`src/server/adapters/codex/reducer.ts`), so one reshaped notification from a CLI updated that morning exits the server and every session with it.
  Separately, the adapter contract has no exit signal: a child that dies reaches `SessionManager` (`src/server/http/session-manager.ts`) only as an `onError` message, and the session stays attached over a dead process until a Detach; D26's `ended` event is the natural carrier.
- Backend drift is detected at home and evidenced from work.
  A canary on the home server runs the smoke probes when a CLI's version changes and diffs each event census against its fixture, which is OW-pukado on a timer.
  A structure-only recorder in the server writes each session's backend lines with every string replaced by its length, so a failure at work comes home as a fixture without any work content.
- The interaction state of both clients gets one owner, as D24 gave the server's.
  A reader's classification of the 332 fix commits between 2026-09-15 and 2026-10-15 put 58% of them as races, 115 in Emacs and 49 in the browser.
  Each gesture (send, edit-and-fork, Stop, attach, the external editor) is a sequence of requests that each client runs alone, held as flags in `src/client/controller.ts` and `src/client/App.svelte` and as buffer-locals in `emacs/agentpane.el`, and `PromptResponse` carries no prompt id to correlate by.
  Candidates are a server verb per gesture, a prompt id echoed on the turn's events, and capability flags on the session view, with generated-interleaving tests (no property-based test exists in the repo) in place of one hand-scripted ordering per test.
  A design issue first.
- ERT runs in `bun run check` and in CI: the 280 tests in `emacs/agentpane-test.el` run in neither, and `AGENTS.md`, "Commands", does not name the command.
- Pi's steering queue and retry status reach both clients, with a send-when-idle beside steering: the Pi reducer drops `queue_update` and `auto_retry_start` (`src/server/adapters/pi/reducer.ts`), and Pi's RPC has `follow_up`.
- D12's reaper and cap, OW-33 and OW-34, once agentpane runs all day anywhere.

The survey's other seed, remote access to agentpane, was set aside by the owner on 2026-10-23; how to use agentpane at home is a separate discussion.

## Done when

The decision is recorded where the next session looks: `AGENTS.md`, "Cards" and "Landing work", say whether GitHub Issues is the tracker of record and how cards relate to an issue, and `docs/TRACKING.md` gains the dated reason.
Whatever the answer, the close note says what it means for the open deck: under a yes, the seed issues, the triage and the three mechanics above are the first work under the new tracker; under a no, the deck stays the tracker and the note says why.

## Close note

The card triage of 2026-10-31 to 2026-11-01 did the move this card proposed without it: every open card was promoted to a GitHub issue (ark3/agentpane#3 to #35), declined or closed moot, so GitHub Issues is now where outstanding work is tracked.
The question this card left open went with the triage and changed shape there: the owner has since said issues are not the project's durable record, and where that record lives is parked in `docs/work/TRIAGE.md`, "State at the end of the first session".
The body's recommendation stands: agent sessions should reach issues through a fine-grained token scoped to this repository's issues rather than a broad login, which the owner is setting up as of 2026-11-13.
