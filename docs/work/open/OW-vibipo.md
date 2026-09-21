---
labels: [question, emacs]
---

# Which Emacs client agentpane builds, agent-shell over an ACP shim or a native mode over its own JSON-RPC helper, is undecided and closes as D21

Filed 2026-09-15.
Two streams of cards now describe an Emacs client, and nothing records which one the project is building.

- `agent-shell` over an ACP shim: OW-fenobo, OW-basoga, OW-limejo, with OW-mikuyo deferred behind it.
  Its case, in OW-basoga: no Emacs rendering is written, and every fork and session fact stays agentpane's.
- A native `agentpane-mode` over a JSON-RPC helper agentpane owns: OW-mutufa, OW-refibu, OW-wavone, OW-gunuke, OW-fojike.
  Its case, in OW-mutufa: the owner used `agent-shell` and found the fit costs more than it saves, and a protocol agentpane owns has a field for everything ACP had to smuggle, chiefly the fork point, the model gate and `request` events.

OW-wawipu belongs to neither stream and stands whichever is chosen.

The two streams share their first module in all but output type, so the cost of deciding late is small until either stream's second card starts.
Both may also be explored: the reader who has used both for a week is the one this card is written for, and a rough cut of each is what `docs/DESIGN.md` D14's own history says UI decisions come from.

## Fork is not a differentiator between the streams

Measured 2026-09-21 by reading the installed `agent-shell` at 7377ba8 and `acp.el` 0.15.1 against `src/shared/protocol.ts`, then against the shim cards.

OW-mutufa's case names the fork point first among what ACP has to smuggle, and the raw protocol bears that out: `acp-make-session-fork-request` sends `sessionId`, `cwd`, `mcpServers` and `_meta` and nothing else, so ACP's own fork has no point and `agent-shell-fork` branches from the tip.
Its forked buffer also renders no history, because the replay machinery is wired to `session/resume` and `session/load` only.

But OW-limejo already answers this, and answers it well: `_meta.agentpane.entryId` on `session/fork`, with the points fetched through an `_agentpane/forkPoints` extension method and offered in a `completing-read`.
`_meta` is the field ACP provides for exactly this, `agent-shell-fork` keeps working from the tip unmodified, and the cost is one command in `emacs/agentpane.el`.
So the fork point is not smuggled so much as carried in the envelope ACP has for it, and this card should not be decided on fork.
The model gate and `request` events are untouched by this reading and remain OW-mutufa's case.

Two things to keep whichever stream wins.
The fork point must come from `/fork-points`, never counted from the buffer, which OW-limejo already does: `agent-shell-ui-state` at point yields `:namespace-id`, which is `shell-maker`'s buffer-local request counter, and `ForkPoint.index`'s docblock records that counting user messages was already falsified by Codex steering and failed silently.
A picker over the points is also the only shape that can decline to fork on a message no point names.

## What the shim cards do not yet cover

The rest of the ACP mismatch is already answered -- OW-basoga re-keys on `renamed`, re-snapshots on a `seq` gap, enforces the model gate itself, serves `session/load` from `GET .../preview` so preview costs no Emacs rendering, and puts the backend on the shim's command line so one `agent-shell` config per backend carries what `SessionRef` carries.
Four gaps remain, and they are the shim stream's real cost rather than fork:

- Compaction.
  `compaction: "requesting" | "running" | null` rides on `snapshot` and `status`, and ACP has no compaction method or state; a slash command loses the state signal.
- `sessions-changed`.
  A server push that the list changed has no ACP carrier, because ACP notifications are session-scoped, so Emacs would poll.
- `status` and `isStreaming` in the list.
  ACP's session entries have no field for either -- `agent-shell` reads `sessionId`, `title`, `cwd`, `updatedAt` and `createdAt` -- so the shim's list cannot show which sessions are live or attached, which `SessionSummary` exists to show.
- `issuerThreadId`, which routes a spawned Codex child's blocking request through the parent adapter, and `AssistantTurn.effort`.

## Done when

The decision is recorded in `docs/DESIGN.md` as D21, with the reason, on the same day the other stream's open cards close `--declined` citing D21.
The closing act also writes the sentence OW-basoga planned for D14, scoping it to the browser client, since it is true of both streams.
