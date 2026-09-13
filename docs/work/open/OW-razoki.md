---
labels: [defect]
blocked-by: [OW-risuwo]
---

# Claude's fork kills the parent's process and reuses its container, where Codex leaves the parent alone and lets the client attach the fork as its own session

Filed 2026-09-13.
The owner's model of a fork, stated in discussion: the original session stays as it is, a new session container starts, and both end up full-fledged sessions.
Codex already works that way.
Claude does not, and the difference is agentpane's, not the CLI's.

## What each backend does today

`src/server/adapters/codex/adapter.ts` `fork()` fires `thread/fork` and returns `{ backend: "codex", id: forked.thread.id }` without repointing `this.threadId`.
The parent's adapter is untouched, `SessionManager`'s `#adoptRef` early-returns because the ref did not change, and the client attaches the returned ref into a container of its own.

`src/server/adapters/claude/adapter.ts` `fork()` calls `replaceProcess`, whose first acts are `previous.live = false`, rejecting the pending controls, and `await previous.proc.kill()`, before spawning on `--resume <id> --resume-session-at <entryId> --fork-session`.
One adapter, one child, and `currentRef` now names the fork.
The parent's process is gone and its container has been re-keyed onto the fork.

## Why this is agentpane's choice and not the backend's

OW-japuzo measured it on the home server, 2026-09-11, `claude 2.1.268`, `--model haiku` (`docs/MANUAL_TESTING.md`, "A mid-stream fork on Claude Code loses the partial reply, but only because agentpane kills the process").
Spawned as a second child rather than replacing the first, the fork came up, adopted the session id it was given, answered its own prompt with `result` success and has its own store -- while the parent emitted 160 further deltas, settled `success` with `is_error: false`, and wrote its whole reply durably.
Two `claude` children with live turns overlapped on one workspace, one resuming the other's store file mid-write, neither erroring.
What ends the parent's turn is `replaceProcess`'s kill, not the CLI.

That run also settled the cost: nothing reaches `~/.claude/projects/<munged-cwd>/<session-id>.jsonl` until after the wire says the turn is over, measured at four marks across one reply, the last at about 78% of a 1491-character answer with the file still byte-identical.
So a fork mid-turn today destroys the whole reply, where the same thing on Codex leaves it durable.

## The shape of the fix

Claude's `fork()` returns a ref for a *new* session and leaves this adapter on the parent, the way Codex's does.
The client already attaches whatever `fork()` returns, so the fork gets a container, an adapter and a process of its own by the path that already exists.

This is smaller than the refactor OW-japuzo's close note sized.
That note weighed running two children under one adapter -- "`Ownership` is a single nullable field, `replaceProcess` a swap over it, one `controlNamespace` and one `pendingControls` per adapter rejected wholesale on fork" -- and all of that stays one-per-adapter here, because the fork gets a different adapter rather than a second child under this one.
Read that paragraph as the alternative that was rejected, not as this card's cost.

The open question is where the fork's process gets spawned from, since `fork()` currently owns that spawn and would no longer do it.
`SessionManager`'s attach path already spawns for a stored session it has never seen; whether the fork can simply ride that, or whether the manager needs to be told the ref exists before the store does, is the design work here.
The Claude CLI is authoritative about its own store and `--session-id` mints the fork's id synchronously at spawn, so the id is known before anything is written.

## Interaction with the two cards beside it

`OW-kekoji` stops a fork from aliasing the parent onto the fork.
This card reduces what that costs on Claude -- an unaliased parent whose process was never killed is simply attached -- but neither card needs the other to land first, and this one must not assume the alias is gone.

`OW-ziyobe` is the abort decision, and it falls out of this: once the parent survives a fork on Claude as it does on Codex, the abort in `src/client/controller.ts` `forkAndSubmit` is left standing only where the backend forces it, which is Pi.
Do not change the abort or the labels here.

## Done when

A test under `src/server/adapters/claude/` goes red first: after `fork()`, the parent adapter's process is still live and its ref unchanged, and the returned ref names a different session.
The existing fork tests that assert the re-key and the `--fork-session` spawn are rewritten to the new contract rather than deleted, and any that cannot be are named in the close note.

A live run on the home server confirms it end to end with `claude --model haiku`: fork a session mid-turn through agentpane, and the parent finishes its reply and has it on disk while the fork answers its own prompt.
`docs/MANUAL_TESTING.md` carries that, since OW-japuzo's section measured the probe's version of this and not agentpane's.

The adapter docblock's bullet -- "`fork()` respawns THIS adapter's child onto the forked session ... so like Pi -- and unlike Codex -- `adapter.ref` changes" -- is rewritten, and `SessionManager.fork`'s docblock likewise if it names Claude on Pi's path.
