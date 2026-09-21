---
labels: [change, emacs, emacs-native]
---

# A pure projection turns agentpane transcripts into the section nodes a native Emacs mode draws, one node per message, for replay and streaming alike

Filed 2026-09-15 from the owner's discussion of a second Emacs approach.
The stream it opens: a native Emacs major mode over a JSON-RPC protocol agentpane owns, with no `agent-shell` and no ACP.
The alternative stream is OW-fenobo, OW-basoga and OW-limejo; this stream leaves those cards standing and cites them where the same design work was already done.
The owner's reason, stated 2026-09-15 after using `agent-shell`: a UI agentpane owns end to end avoids the minor annoyances of fitting agentpane onto someone else's client, which is the reason agentpane exists rather than a browser plug-in for some other frontend.

This card is the counterpart of OW-fenobo with a different output type.
Everything OW-fenobo says about inputs, reuse and streaming carries over; read it first, since this card only says where this stream departs.

## What it maps

Input is what the wire already carries: a `snapshot`'s `messages`, the `turns` a `SessionPreviewResponse` returns after `previewMessages` in `src/client/preview.ts` has stamped them, and the tail `upsert`s of a live turn (`src/shared/protocol.ts`, `ServerEvent`).
Output is a list of nodes, one per visible transcript entry, in the shape `src/emacs/protocol.ts` defines and its docblock documents as the contract the elisp reads.
That file is this stream's D11: both ends are ours, the elisp reads JSON with no type checker behind it, and the docblock is what the elisp author reads.

Each node carries at least:

- `index`, the position in `snapshot.messages` that `upsert.index` and `ForkPoint.index` address (D20), which is what makes fork-at-point native later and lets the Emacs buffer replace one node in place.
- `role`, one of user, assistant, tool-result for an orphan result, and whatever else the transcript holds.
- Ordered `parts`: a text part carries the markdown source as it is, since Emacs fontifies markdown itself and there is no HTML on this path; a thinking part carries its text and whether it was redacted; a tool part carries the name, `toolSummary(call)` from `src/client/render/tools/summary.ts`, `prettyArgs` from `args.ts`, the folded result's text through `resultText` in `src/client/render/types.ts`, its `toolState`, and for an edit or write the `buildDiff` lines from `diff.ts` so the elisp draws a unified diff without computing one.
- A meta line for an assistant turn: model, `effort`, usage, and `stopReason` where it is `error` or `aborted`, since `condense` in `src/client/render/transcript.ts` keeps that banner for the same reason.

Tool results fold into their calls through `buildTranscript` in `src/client/render/transcript.ts`, unchanged; an orphan result is its own node, as it is in the browser.
Unknown tool names get the generic tool part, the same principle as D5's default card.
Images: a user image part carries the mime type and base64; a first cut may render it as a placeholder line, and the card for the mode says so.

## Streaming

One code path, two callers, as OW-fenobo puts it.
Replay maps a whole transcript to nodes.
Streaming maps one `upsert` to the one node it replaces, whole.
Sending the whole node per upsert rather than per-block suffixes is a first cut chosen on 2026-09-15 for simplicity: `ewoc-invalidate` redraws one node, the wire is loopback, and a message is bounded by one turn.
Measure it on a long turn before choosing deltas; if whole-node redraw visibly lags or flickers, OW-fenobo's suffix rule is the delta design already written, and the change stays inside this module and the buffer's pretty-printer.

## Where it lives

A new tree `src/emacs/`, with a `$emacs/*` alias in `tsconfig.json` and `vite.config.ts`, and `src/emacs/**/*.{test,spec}.ts` added to the vitest `server` project's `include` in `vite.config.ts` so the tests run in node.
The module imports `$client/render/transcript.ts`, `$client/render/types.ts`, `$client/preview.ts` and `$client/render/tools/*` directly; they are plain TypeScript with no DOM dependency, and vitest chooses the environment by the test file's path, not by what it imports.
D10 holds: the pi packages are `import type` only, and `src/import-boundaries.test.ts` names any file that breaks that.
Add one sentence to `AGENTS.md` under Code saying `src/emacs/` runs in node and imports client modules by design.

## Done when

Tests in `src/emacs/` assert on structure, never on model wording, over the recorded turns for Codex and Claude.
Fixture input comes from the recordings under `resources/fixtures/` replayed through each adapter's reducer, the way the `replay` helper in `src/server/adapters/claude/reducer.test.ts` and `src/server/adapters/codex/reducer.test.ts` does it: `readFixture` from the sibling `test-support.ts`, every line through `CodexReducer.handle` or `ClaudeReducer.handle`, and `getState().messages` as the transcript.
Those recordings are RPC-stream captures, not store files, so `readSessionPreview` cannot read them; `src/server/sessions/preview.test.ts` says so in its docblock and synthesizes store lines by hand for that reason (corrected 2026-09-21, the card first said otherwise).
A replayed fixture yields nodes in transcript order whose indices are the original message indices with folded results absent, an Edit call yields a tool part carrying diff lines, a thinking block yields a thinking part, and an aborted turn yields a meta line saying so.
A sequence of upserts for one tail index yields nodes whose last text part equals the final message's text.
`bun run check` passes.
