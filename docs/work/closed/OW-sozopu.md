---
labels: [change, sweep-0929]
closed: done
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

## Amended 2026-09-29

A sweep of the open deck for consolidations (read against e1cf2e6) found two more cards that are this shell's duplication showing, and one shell absorbs them:
- OW-16: the kill escalation drops `closesWithin`'s result in all three shells now, not two (`finishTermination` or its equivalent in `codex/process.ts`, `claude/process.ts` and `pi/process.ts`).
- OW-10: a spawn error is flattened to a string in all three shells, not only Pi's.
  `onError` hands clients a string, so the error's identity is lost at the contract anyway; the shell should keep `cause` on what it throws internally, and whether anything more is worth it is a candidate to decline inside this card.

Done also requires: a test that a child not closed within the escalation's deadline after SIGKILL is reported (through `onError` or a rejected `dispose()`, recorded in the docblock which), and a test that a spawn failure's internal error carries the original as `cause`.
Then OW-16 and OW-10 close `--moot` citing this card.

## Amended 2026-09-30

Checked against 73f7123 before dispatch; the defect, the missing `start()` guard and the three escalation copies all hold as written.
Two corrections:
- Pi's splitter is `LfLineSplitter` in `src/server/adapters/pi/framing.ts`, returning lines rather than taking an emit callback, so `rg -n 'class LineSplitter' src/server` already returns two, not three.
  The check is `rg -n 'class \w*LineSplitter' src/server` returning one definition.
- `codex/process.test.ts` imports `LineSplitter` from `./process.ts` and `pi/framing.test.ts` imports `LfLineSplitter` from `./framing.ts`, and Pi's `FakeStdin` in `pi/process.test.ts` has no `on` method.
  "Without edits to their assertions" means the `expect` lines; import paths and the fakes' plumbing may change to follow the shell.

The smaller repeats named under "Why it is one card with the duplication" (`ZERO_USAGE`/`emptyUsage`, `isRecord`, `idFromFilename`, the Claude store root) are not child-process plumbing, which the card scopes itself to, and are not in the done-condition; they are OW-tijilo's.

## Close note

Built: one process shell, `ChildProcessShell` in `src/server/adapters/child-process.ts`, owning spawn-error capture, the stderr tail, stdout framing, the stdin `error` listener, `close`, and the SIGTERM/SIGKILL escalation, parameterised by the line handler.
`spawnCodex` and `spawnClaude` return it behind the unchanged `CodexProcess`/`ClaudeProcess` seams, and `PiAdapter` wraps its injected `PiSpawn` child in it (`PiChild` is now an alias of the shell's `ChildLike`).
The one LF splitter is `LfLineSplitter` in `src/server/adapters/framing.ts`, moved from `pi/framing.ts` with its not-`readline` rationale.
`PiAdapter.start()` rejects after `dispose()` or a second start, as Codex's and Claude's do.

Measured along the way (2026-09-30), now in DESIGN's "What the wrapper chain does to process events": with no stdin `error` listener, a write into a pipe whose reader closed crashes Bun 1.4.0 once it passes a few KB (1000 and 4000 bytes survived, 8000 and 65536 exited 1 with an uncaught EPIPE) and Node 26.8.1 on any write — so Pi's missing listener could take the server down on a long prompt.
Also retired: the Pi `dispose()` docblock's claim that a second `stdin.end()` raises ERR_STREAM_ALREADY_FINISHED; neither runtime threw or emitted on it.

Absorbed OW-16 (a child outliving SIGKILL now fires `onExit` once with a "did not close" error) and OW-10 (spawn and stdin errors kept as `cause`), both closed moot.
The adversarial read caught that a stdin EPIPE had displaced Pi's exit code in the death report; the report now carries both.

Verified: new tests shown red before their fix — Pi stdin EPIPE reported through `onError` with the exit code, `start()` after `dispose()` rejects without spawning, the post-SIGKILL survivor is reported, spawn-failure cause kept; `rg -n 'class \w*LineSplitter' src/server` returns one; `bun run check` green on main (1587 tests).
One existing assertion changed: Pi's escalation test expected `kill()` with no signal and now expects `"SIGTERM"`, which Codex's test pinned; the effect is the same. Codex's four `LineSplitter` tests moved to `framing.test.ts` with their `expect` lines unchanged.

Left: OW-tozuyo (the survivor report reaches nobody), OW-pazuwi (a command written before an EPIPE waits on a `close` that a still-running child never sends), OW-tijilo (the small repeated helpers outside child-process plumbing).
The "already started" guard in `PiAdapter.start()` has no test; no caller starts an adapter twice.
