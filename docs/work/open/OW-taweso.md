---
labels: [question]
---

# After a compaction, the transcript shows the context handed to the fresh session as a user message, so it misattributes who said what from then on

Reported by the owner on 2026-10-01: every time they compact in agentpane, the context passed to the fresh session ahead of the last few turns appears in the transcript as a user message, on all three backends.
The transcript then reads as though the owner wrote that text, and is misleading from that point on.

This is not OW-wapage's question, closed 2026-10-01, which was whether the Codex compaction marker could carry a summary.
The two meet at one point: text moved off a user turn would most naturally go onto the marker.

The code means to prevent this in at least one place.
The Claude Code live reducer, `src/server/adapters/claude/reducer.ts`, at "The post-compaction summary arrives as an isSynthetic user message; it belongs on the marker", moves an `isSynthetic` or `isCompactSummary` user message onto the compaction marker.
So a Claude case that still shows it probably comes through a path that guard does not cover, and nothing has been checked for Pi or Codex.

## What the owner's description should settle

Nothing is investigated until the owner has described what they see, because the symptom needs pinning down before evidence is gathered.

- Which backends, and whether all three look the same.
- When it appears: right after the compaction in the live transcript, after a reload or a re-attach, in the read-only preview, or in all of them.
- What the text is: a summary prose block, the carried-over turns repeated, or both.
- Whether it shows in the browser, in agentpane-mode, or in both.
- What the owner expects in its place: nothing, the text on the compaction marker, or the text shown but attributed to the system.

## Done when

The owner's answers are recorded in this card, and defect cards are filed from them naming the backends and paths to reproduce, each with a fixture or live capture as its evidence; this card then closes `--done` with their ids.
