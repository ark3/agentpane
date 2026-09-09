---
labels: [change]
---

# Pi's child stdin has no `error` listener, and the three process shells are the same hundred lines, which is how the fix landed in two of them

## The defect

`src/server/adapters/pi/process.ts`, `writeLine`: it guards on `disposed`, `closed`, and `destroyed` and then writes to `child.stdin`.
`closed` flips only on the child's `close` event, which fires after stdout and stderr drain, so a `submit` or `abort` landing after Pi has died but before `close` writes into a pipe with no reader.
A Node stream with no `error` listener turns that EPIPE into an uncaught exception.
The docblock a few lines above the disposal code already names the consequence ("a stream nobody is listening to for `error` ... takes the server down") and relies on ordering rather than a listener.
Codex and Claude both attach one: `child.stdin.on("error", ...)` in `src/server/adapters/codex/process.ts` and `src/server/adapters/claude/process.ts`.
Pi does not.

While there, `PiAdapter.start()` in the same file has no `disposed` or already-started guard where Codex's and Claude's `start()` both begin with one.
`dispose()` then `start()` spawns a child the memoised disposal will never kill.
The manager does not currently hit that ordering; it is a contract hole, not a live leak.

## Why it is one card with the duplication

The reason the listener exists in two of three shells is that there are three shells.
`LineSplitter` is defined in `pi/framing.ts`, `codex/process.ts`, and `claude/process.ts`, byte-identical apart from the emit signature.
`ChildCodexProcess` and `ChildClaudeProcess` are the same class with the backend's name swapped, and Pi's `finishDisposal` / `closesWithin` / `handleClose` are a third copy of the same SIGTERM, bounded wait, SIGKILL escalation, with a third `STDERR_TAIL_LIMIT` and a third grace constant.
Smaller repeats sit beside them: `ZERO_USAGE` / `emptyUsage` in `codex/mapping.ts`, `claude/mapping.ts`, and `sessions/preview-message.ts`; `isRecord` in `codex/protocol.ts`, `claude/protocol.ts`, and `preview-message.ts`, where the last one does not exclude arrays and the other two do; `idFromFilename` in `sessions/codex.ts` and `sessions/claude.ts`; the Claude store root `join(homedir(), ".claude", "projects")` in `claude/adapter.ts` and `sessions/index.ts`.

One process shell that owns spawn, the stderr tail, both stdio listeners, and the escalation, parameterised by the line handler, makes the next such fix land once.
The adapters keep their protocol layers; only the child-process plumbing moves.
DESIGN's "What the wrapper chain does to process events" is the contract the shell has to keep, and `src/server/adapters/pi/process.test.ts` plus the Codex and Claude `process.test.ts` files are the tests that have to keep passing unchanged.

## Done when

- A test in `pi/process.test.ts` emits `error` on the fake child's stdin after a write and asserts the adapter reports it through `onError` rather than throwing; it fails before the change.
- A test asserts `PiAdapter.start()` after `dispose()` rejects.
- `rg -n 'class LineSplitter' src/server` returns one definition, and the three escalation sequences are one.
- The existing process tests for all three adapters pass without edits to their assertions.
