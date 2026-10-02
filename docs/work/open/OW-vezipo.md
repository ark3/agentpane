---
labels: [change, d27]
---

# A forked session's row in the list is a character-for-character copy of its parent's, so the two cannot be told apart.

`src/shared/protocol.ts` (`SessionSummary`), `src/server/sessions/pi.ts` (`parsePiSession`), `src/server/sessions/codex.ts` (its header read and the module docblock on subagent rollouts), `src/server/sessions/claude.ts`, `src/emacs/protocol.ts` (the `sessions/list` entry of its docblock).

`SessionSummary.preview` is the first user message, and a fork carries the history up to the fork point, so a fork's preview is its parent's and the two rows are identical but for their timestamps.
Since OW-kekoji (`0edd97e`) the parent stays listed beside a fork on all three backends, so the twins are live everywhere; OW-sehaja (`732769a`) is a different thing, stopping a fork from wearing its parent's *stored* preview.

Rewritten 2026-10-01 under `docs/DESIGN.md` D27 (OW-fifaji), and no longer a deferral.
The owner had deferred this on 2026-08-19 to hiding some kinds of fork automatically, which waits on OW-66 and on use; D27 keeps that deferred but takes the cheapest of the three alternatives named here before, marking lineage on the row, which needs no verdict from use.
This card is the wire half: `forkedFrom` on `SessionSummary`.
Hiding forks automatically stays deferred, now in OW-ruyewe.
The markers are OW-galuhu in the browser and OW-kepemu in agentpane-mode, each blocked by this card, per `AGENTS.md`, "Both clients".

## Where the parent is

Agentpane records no parentage of its own, and needs none: the backends write it into the session file's header, so it is readable retroactively for every fork already taken, by the walk `src/server/sessions/` already performs.
Checked in the committed captures on 2026-08-19:

- Pi: `"parentSession"` in the `session` header line, a JSONL path (`resources/fixtures/pi/fork.jsonl`, first line), which is already a Pi ref's id (D9).
- Codex: `"forked_from_id"` inside `session_meta` (`resources/fixtures/codex/fork.jsonl`, first line), a thread id, which is already a Codex ref's id.
  A subagent's rollout carries `forked_from_id` too, naming the parent thread that spawned it, and that is not a fork: the docblock at the head of `src/server/sessions/codex.ts` gives the census and names `thread_source === "subagent"` as the marker.
  So a Codex summary's `forkedFrom` is null on a subagent rollout.
- Claude Code: the Goals section of `docs/DESIGN.md` says "Pi and Codex record lineage on disk; Claude Code does not", with no version behind it.
  Fork a session on the home server (`claude --model haiku`), read the fork's store file for anything naming the parent, and record what was found, with the version, in `docs/MANUAL_TESTING.md`.
  Whatever it shows, Claude's `forkedFrom` follows it, and the Goals sentence is corrected or given its version in the same change.

## What has to exist

- `forkedFrom: SessionRef | null` on `SessionSummary`, filled by each parser from what its header holds, null where it holds nothing.
- The `sessions/list` entry of the `src/emacs/protocol.ts` docblock lists the summary's fields and gains `forkedFrom`, and the docblock records the raising.

A fork born without a file (D9) is listed from the manager before the walk can read its header.
Whether its summary carries `forkedFrom` from the moment `SessionManager.fork` makes it, or only once the walk finds its file, is decided in flight and said in the close note.

## Done when

Each watched red first.

1. A Pi parser test reads a header with `parentSession` and asserts `forkedFrom` is the Pi ref of that path, and a header without one yields null.
2. A Codex parser test asserts `forkedFrom` is the Codex ref of `forked_from_id` for a fork, and null for a rollout whose `thread_source` is `subagent`.
3. A Claude parser test asserts whatever the live run found.

`bun run check` passes.
