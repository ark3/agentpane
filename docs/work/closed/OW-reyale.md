---
labels: [change]
---

# A stored session previews as text only, so tool calls and thinking are invisible and the reading-view toggle is inert on it.

Asked for by the owner 2026-08-27: a preview should render the way an attached session does, tool and thinking chrome included, and the reading-view toggle should genuinely elide that chrome on a preview the way it does on a live one.

## Where the narrowing lives

The renderer is already shared, so this is not a second-renderer problem.
OW-50 (closed) deleted the preview's own markup and CSS; `src/client/preview.ts` maps turns to message-shaped objects and both paths go through `Transcript`.
What is narrow is the *payload*: `SessionPreviewTurn` (`src/shared/protocol.ts`) is `{ role: "user" | "assistant"; text; timestamp? }`, and the three extractors — `extractPiPreviewTurns` (`src/server/sessions/pi.ts`), `extractCodexPreviewTurns` (`codex.ts`), `extractClaudePreviewTurns` (`claude.ts`) — keep only user and assistant text.
Tools, thinking, images and approvals are dropped at the source, so there is nothing for the client to render or for `condense` to elide.

The toggle has a second, independent break.
`App.svelte` passes `{reading}` to the live `<Transcript>` and **not** to the preview one, so even a full payload would leave the toggle inert on a preview until that prop is passed.
Both halves are in scope here.

## This reverses OW-50's instruction, deliberately

OW-50 says in as many words: *"Do not widen `SessionPreviewResponse` to carry `AgentMessage`s."*
That was right for OW-50, whose whole scope was client-side de-duplication of a renderer; it is the thing this card is for.
Read OW-50 before starting anyway, because its reason is the actual work here and has not gone away: **stored Codex records are `response_item` payloads, not the `ThreadItem`s `src/server/adapters/codex/mapping.ts` consumes**, so the live mapper cannot be reused against the store and a second one is needed.
Expect the same shape of problem for Claude Code (`src/server/adapters/claude/mapping.ts`) and to a lesser degree for Pi.
Budget the card accordingly: the wire type and the client are small, and three store-format mappers are not.

If that proves too big to land in one go, split it per backend and say so in the close note — but land the wire shape once, not three times.

## What must survive

**One file, no subprocess.** D9's cheap-selection goal and the whole point of `src/server/sessions/preview.ts`: a preview reads exactly one session file and spawns nothing.
`preview.test.ts`'s two "reads only the matching file, never the other seeded sessions" tests are the guard; they stay green.
Richer content per file is fine, more files is not.

Note while you are there that D9 is cited in `preview.ts`'s module docblock and in `SessionPreviewTurn`'s docblock as the reason for the *content* narrowing, which it never supported — D9 bounds which files are read, not what is kept from the one that is.
Those docblocks are being rewritten by this card regardless; do not carry the bad reason forward.

**Synthetic user-turn wrappers stay filtered.** OW-38 filters `<environment_context>` and friends via `isSyntheticBlock`.
That is not tool chrome and the reading toggle is not the place to handle it.

## Claims this change makes false, all of which it must retire

The old answer is asserted in at least four places, and a fix that leaves any of them standing has left the next reader a lie:

- `src/client/App.svelte`, the comment above the previewing branch of `.conversation`: *"text turns only, no streaming, no tool/thinking chrome -- deliberately not a claim of live parity."*
- `src/client/App.svelte`, the comment above the Reading view button: *"a preview renders no tool chrome to elide, and a control that appears and disappears on attach is worse than one that is briefly a no-op."* The button stays put; only the no-op justification dies.
- `src/client/App.test.ts`, the test "keeps the reading view toggle visible while previewing", whose comment says *"A preview has no tool chrome to elide, so the toggle is a no-op there."* This test now has something real to assert.
- `src/client/preview.ts` and `src/server/sessions/preview.ts` module docblocks, plus `SessionPreviewTurn`'s in `src/shared/protocol.ts`.

Grep `text turns only` and `no tool` before you finish.

One judgement call to make rather than inherit: `.preview-empty`'s wording, *"This session has no readable transcript to preview"*, exists because text-only extraction could come up empty on a session with plenty in it.
With full fidelity that case largely goes away, so decide whether the special-cased empty branch still earns its place or should fall through to `Transcript`'s own empty state, and record which in the close note.

## Done

`bun run check` passes, and these fail first:

Server, in `src/server/sessions/preview.test.ts`: for each of Pi, Codex and Claude Code, a synthesized store-format session containing a tool call and a thinking block previews with those present, asserted on structure and never on model wording.
The existing "reads only the matching file" tests still pass unchanged.

Client, in `src/client/App.test.ts`: extend "keeps the reading view toggle visible while previewing" so that a preview carrying tool and thinking content shows that chrome with the toggle off, hides it with the toggle on, and restores it — the same assertions the sibling test "hides tool and thinking chrome behind the reading view toggle, and restores it" already makes for an attached session.
That sibling is the pattern to copy, and the two passing together is what "renders the same way" means operationally.

All jsdom- and node-visible; `bun run test:browser` is not implicated.

Stored-session previews now carry rich transcript message structure over the preview wire and render through the shared Transcript with Reading view able to show, hide, and restore tool and thinking chrome. Pi maps native stored messages, Codex maps stored response_item records, and Claude replays store records through hydration while preserving synthetic-user filtering; the preview route still reads exactly one file and spawns nothing. Empty previews now use Transcript's own "No messages yet." state because full-fidelity extraction removes the old distinction between an empty session and a session whose readable content was discarded. Adversarial review found that real Claude store compaction records use camelCase compactMetadata/isCompactSummary rather than the live stream's snake_case/isSynthetic fields; both spellings now hydrate into one timestamped compaction marker, pinned by a red-first store-format regression and verified against an actual stored session with no leaked continuation-summary user turn. The required Pi, Codex, Claude, and client regressions were observed failing before implementation. `bun run check` passes with 47 test files and 871 tests; browser tests were not implicated by the changed areas.
