---
labels: [change, emacs]
---

# A pure mapping turns agentpane transcripts into ACP session/update notifications, for replay and for streaming alike

Filed 2026-09-13 from the owner's discussion of an Emacs client.
The decision it serves: the Emacs UI is `agent-shell`, driven over the Agent Client Protocol (ACP) by a Bun shim that is a client of agentpane's HTTP API, so no Emacs rendering is written and every fork and session fact stays agentpane's.
The shim is the next card; this one is the module the shim is mostly made of, and it is implementable and testable on its own.

## What it maps

Input is what the wire already carries: a `snapshot` or the transcript a `SessionPreviewResponse` returns, and the tail `upsert`s of a live turn (`src/shared/protocol.ts`, `ServerEvent`).
Output is a list of ACP `session/update` params.
The kinds `agent-shell` renders are the target set: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`; the rest (`plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `session_push_end`) are not produced.
The ACP schema is at https://agentclientprotocol.com/protocol/schema; `acp.el` and `agent-shell` on the home server are at `~/.emacs.d/straight/repos/`, pulled 2026-09-13 to `acp.el` 0f2cac4 and `agent-shell` 7377ba8, and `agent-shell.el`'s `session/update` dispatch is the consumer to read against.

Two modes over one code path:

- Replay: a whole transcript becomes the updates that reproduce it, which is what `session/load` streams back.
- Streaming: an `upsert` for the tail message becomes the suffix since the last-seen version of that message, per block, so each text or thinking block yields one chunk carrying only the new text.
  When the retained tail is not a prefix of the new one, emit the whole block again and say so in a comment; that duplicates text once in the rare mid-turn re-snapshot and is accepted.

Tool calls: `tool_call` on first sight with a `kind` and a title, `tool_call_update` with status and content when the matching `ToolResultMessage` folds in.
`src/client/render/transcript.ts` already folds results into calls by `toolCallId` and is reusable as is.
`src/client/render/tools/summary.ts`, `args.ts` and `diff.ts` already produce the one-line summary, formatted arguments and unified diff the browser shows; an Edit or Write call becomes ACP `diff` content with `path`, `oldText` and `newText`, which `agent-shell` renders natively.
Unknown tool names get a generic `tool_call`, the same principle as D5's default card.

Thinking blocks become `agent_thought_chunk`.
An `AssistantTurn`'s `usage` becomes `usage_update`.
A `request` event has no ACP answer here: the adapter already declines what nobody can answer (D2a, OW-yikoyo), so it is surfaced as a text chunk saying what arrived, and nothing is held.

## Where it lives

A new tree `src/acp/`, with a `$acp/*` alias in `tsconfig.json` and `vite.config.ts`, and its test glob added to the vitest `server` project's `include` so the tests run in node.
The module imports `$client/render/transcript.ts` and `$client/render/tools/*` directly; they are plain TypeScript with no DOM dependency, and a test under `src/acp/` runs in node regardless of what it imports because vitest chooses the environment by the test file's path.
D10 holds: the pi packages are `import type` only, and `src/import-boundaries.test.ts` will say so.

## Done when

Tests in `src/acp/` assert on structure over the captured stores under `resources/fixtures/` for both Codex and Claude: a replayed fixture yields user and agent chunks in transcript order with each tool call paired to its update, an Edit call yields a `diff` content item, and a sequence of upserts yields chunks whose concatenation equals the final text.
The replay test and the streaming test share the mapping function, which is the point.
`bun run check` passes.
