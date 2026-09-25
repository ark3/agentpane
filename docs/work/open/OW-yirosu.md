---
labels: [defect]
blocked-by: [OW-vulusi]
---

# Every prompt broadcasts two full-transcript snapshots before it is acknowledged and a third at turn end, where D3 asks for none, and Emacs redraws the whole buffer for each

Owner, 2026-09-25: on a long conversation in agentpane-mode, around line 10,000 of the buffer, pressing `C-RET` takes one to two seconds before the draft clears, while streaming feels fine.
The owner's `profiler` run over one send showed about 1,840 CPU samples: 35% `redisplay_internal`, 29% a truncated deep stack, and 16% automatic GC.

## What a turn broadcasts

Measured live on the home server on 2026-09-25, `claude 2.1.280`, `--model haiku`, through a private server started as `PORT=4199 bun run src/server/index.ts`.
A Bun script read `/api/events` as raw SSE, created a Claude session in a scratch directory that had been `git init`ed (the home server's `claude` wrapper refuses a directory with no workspace marker), attached it, and sent two one-word prompts 20 seconds apart, logging each event's type.
Each prompt produced this, with the prompt's `202` arriving after both snapshots:

    snapshot  messages=2 isStreaming=false   ← the prompt route's attach
    upsert    index=2 role=user
    status    isStreaming=true
    snapshot  messages=3 isStreaming=true    ← the streaming flip
    prompt answered 202
    upsert    index=3 role=assistant  (×8)
    snapshot  messages=4 isStreaming=false   ← the streaming flip at turn end

There are three sources:
- The `"prompt"` case in `src/server/http/app.ts` calls `sessions.attach(ref)` before `sessions.submit`, so a session that has not been started yet can take its first prompt, and `SessionManager.attach` in `src/server/http/session-manager.ts` re-broadcasts a snapshot for a session that is already attached ("Idempotent: attaching an already-attached session re-snapshots").
  That re-snapshot is load-bearing for `GET` attach, the client's recovery path (see OW-muyawi), and nobody needs it for a prompt.
- `SessionManager.#onUpdate` sends a `status` event only when streaming and compaction are both unchanged and no message changed; a flip of `isStreaming` with no `changedIndex` falls through to `broadcastSnapshot` ("A snapshot carries isStreaming and compaction, so no separate status event").
- Every adapter reports a streaming flip with no index: the `"streaming"` case of `applyEffects` in both `src/server/adapters/claude/adapter.ts` and `src/server/adapters/codex/adapter.ts` calls `emitUpdate(undefined)`, and in Pi `agent_start` and `agent_settled` in `src/server/adapters/pi/reducer.ts` return no `changedIndex`, as does the streaming-off `emitUpdate(undefined)` in `PiProcess`'s exit handling in `src/server/adapters/pi/process.ts`.
  Only Claude was run live; Codex and Pi are read from the code.

D3 in `docs/DESIGN.md` names the snapshot's occasions as "attach, reconnect, and session switch", and none of these three is one of them.

## What a snapshot costs

Measured the same day on a stored Claude session of 348 messages, which projects to 199 nodes and draws 8,298 lines:
- The helper's `notifySnapshot` in `src/emacs/helper.ts` runs `projectTranscript` over every message, markdown to HTML: 300–420 ms warm, 670–870 ms cold.
- `agentpane--draw` in `emacs/agentpane.el` deletes and redraws every node, each text part through shr: 250–450 ms in batch Emacs, byte-compiled or not, with no redisplay, and batch measures `string-pixel-width` in character cells, so a graphical frame costs more.
  Parsing the JSON took 4 ms.
So a send pays roughly two helper projections and two whole-buffer redraws before the prompt's reply clears the draft, and one more of each when the turn ends, which accounts for the one to two seconds.
The browser pays for these snapshots too; that cost was not measured.

## The change

A turn boundary, and a prompt to a session that is already attached, reach clients as the `upsert` and `status` events they already have, and a snapshot goes out only where D3 names one, plus where a snapshot is the only honest report of what changed.
Load-bearing:
- A real transcript replacement still snapshots.
  `emitUpdate(undefined)` also means that today: the Claude and Codex `"reset"` effects, and `PiProcess.hydrateMessages` after a fork.
  So the adapter contract in `src/server/adapters/types.ts`, `onUpdate(cb: (state, changedIndex?) => void)`, has to tell "only the status moved" from "the transcript was replaced", and how it does so is the implementer's call.
- The compaction snapshot that OW-jelovu kept for atomicity (the `hasChangedMessage && compactionChanged` arm, "Keep that reducer-level atomicity on the wire") stays a snapshot.
  Whether a compaction flip that changes no message joins the `status` path is the implementer's call, stated in the close note.
- `GET` attach keeps re-snapshotting an already-attached session; only the prompt route stops doing so.
- Nothing else is known to rely on these snapshots, but OW-vulusi's line does: Emacs clears a drawn turn error only when a snapshot arrives without it, and with neither the turn-start nor the turn-end snapshot sent the line would stay drawn indefinitely.
  That is why this card waits on OW-vulusi.
  The implementer checks the browser (`reduceServerEvent` in `src/client/session-state.ts` and `src/client/controller.ts`) and the helper for anything else a turn-boundary snapshot refreshes, and each thing found either moves onto the `status` event or becomes a card.

## Done

Red first, then green, in `src/server/http/session-manager.test.ts` or `src/server/http/app.test.ts` as fits:
- an adapter flipping `isStreaming` with no message changed broadcasts a `status` event and no `snapshot`, at turn start and at turn end;
- a prompt to an already-attached session broadcasts no `snapshot`;
- an adapter update that replaces the transcript still broadcasts a `snapshot`.
Each adapter's own suite asserts that its streaming flip reports itself as status-only and that its reset or rehydrate does not.
`bun run check` passes.
The live probe above, rerun against the change, shows each prompt producing no snapshot between the prompt and the turn end, and that run goes into `docs/MANUAL_TESTING.md` with its version.
The sentence in the `#onUpdate` docblock and anything else that says a streaming flip snapshots is corrected in the same change.
