---
labels: [unverified]
closed: done
---

# A set_model control request makes Claude Code emit a user event, and nobody knows whether it reaches the transcript

Seen in passing during OW-nabano's run on the home server 2026-09-23, `claude 2.1.280`, no turn: each `set_model` control request (to `haiku`, then back to `claude-sonnet-5`, on a `--resume`d sonnet session) put one event with `type: "user"` and no `subtype` on stdout, before the `set_model` `control_response` arrived.
That is all that was captured: the probe printed only `type` and `subtype`, so the event's keys, its `message` content and any `isSynthetic`/`isMeta`/`isReplay` flag are unknown, and so is whether the store gained a line for it.

## Why it matters

`ClaudeAdapter.setModel` in `src/server/adapters/claude/adapter.ts` sends `set_model`, and `handleLine` hands every non-control event to the reducer, whose `handleUser` in `src/server/adapters/claude/reducer.ts` decides what becomes a user message.
The clients offer `setModel` only before the first prompt (`setModel` in `src/client/controller.ts`, `agentpane--check-model-gate` in `emacs/agentpane.el`), so if this event becomes a user message, a conversation whose model was chosen would open with a stray user entry in the live transcript, and possibly a store line that shows up again on resume and in `listForkPoints`.
`docs/MANUAL_TESTING.md`, "A Claude Code turn at a chosen effort, what `set_model` does to it, and what a resume keeps (OW-hokaye)" and the OW-kakide section drove `set_model` live and recorded nothing about it, which is why this is unverified rather than a known defect.

## Done when

The event is captured whole, on a fresh session and on a resume, with `claude --version` named, recorded in `docs/MANUAL_TESTING.md` along with whether the store file gained a line for it -- spawn with `--model haiku` and set to another model with no turn, or drive the turn on haiku if one is needed, per `AGENTS.md` "Evidence".
Whatever the capture shows, a test in `src/server/adapters/claude/adapter.test.ts` or `reducer.test.ts` feeds that exact event through the adapter after `setModel` and asserts what the transcript holds -- red first if the adapter needs a change to make it hold nothing, and the event added to `resources/fixtures/` if the fixtures README's rules allow it.

## Close note

Captured live on the home server 2026-09-23, `claude 2.1.280`, every spawn `--model haiku`: a `set_model` before a session's first turn writes no event and no store line; after a turn, or on a `--resume`, each `set_model` writes one `{"type":"user", ..., "isReplay":true}` event whose bare-string content is `<local-command-stdout>Set model to ...</local-command-stdout>`, ahead of its `control_response`.
The store gains nothing until a turn runs on the same process, which then writes three user lines per `set_model` (an `isMeta` caveat, the `/model` command line, and the stdout line under the live event's uuid); a process that exits without a turn never records them.
The adapter already drops all of it: `handleUser` in `src/server/adapters/claude/reducer.ts` skips `isReplay`, and `isSyntheticClaudeUserText` catches every line's prefix, live and on hydration and `listForkPoints`.
No adapter change; two tests in `src/server/adapters/claude/adapter.test.ts` pin it, shown red with both guards removed, and the capture is the new fixture `resources/fixtures/claude/set-model.jsonl`.
Evidence is the OW-hiligu section of `docs/MANUAL_TESTING.md`; not tried is whether anything other than a turn (e.g. `/compact`) flushes a `set_model`'s store lines.
