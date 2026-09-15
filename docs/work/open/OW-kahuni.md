---
labels: [deferral]
---

# A turn killed between a tool block's last input_json_delta and its authoritative assistant event now leaves that call's arguments at {}

Filed out of OW-bizulo's adversarial check on 2026-09-15, after that card landed.

`src/server/adapters/claude/reducer.ts`, the `input_json_delta` arm of `handleStreamEvent` and the comment at that site.

OW-bizulo deleted the per-delta accumulation and `JSON.parse`, on the grounds that the block's authoritative `assistant` event always follows and supplies fully-parsed `input`.
That is the shape of every captured fixture: in `resources/fixtures/claude/tool-use.jsonl` (`claude 2.1.238`, captured 2026-08-25) each block's `assistant` event is the line immediately after its last `input_json_delta` and before `content_block_stop`.

The card argued that an abort mid-arguments loses nothing, because what a kill discards is the last good parse, which mid-object is the empty object `content_block_start` seeded.
That reasoning holds everywhere except one window it did not name: between the *final* delta, which closes the JSON and was the one delta whose parse succeeded, and the `assistant` event one line later.
A turn killed inside that window -- interrupt, process kill, stream EOF -- used to leave the tool call's `arguments` fully populated and now leaves them `{}`.

## Why this is a deferral and not a defect

The window is one stream line wide, and the tool never executed, so a card rendering with no `file_path` and no diff is arguably the honest presentation of a call that never happened.
Nothing else breaks: `toolNames` is populated at `content_block_start`, so tool-result pairing by `tool_use_id` is untouched, and `content_block_start` still recomposes, so the tool card still appears.

## What would make it worth doing

A report of an interrupted turn showing a blank tool card where the previous build showed arguments.
Absent that, the cost of reinstating an accumulator to serve one line of stream is the whole of OW-bizulo's deletion back again.

## If it is taken up

The observable is a hand-built event sequence, not a fixture: no capture stops in that window, so a test must feed `content_block_start`, every `input_json_delta` for the block, and then nothing, and assert on the call's `arguments`.
Whatever is decided, record the decision in the comment at the `input_json_delta` arm, which is where the next reader meets the coupling.
