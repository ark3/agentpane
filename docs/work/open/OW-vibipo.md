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

Measured 2026-09-21 by reading the installed `agent-shell` at 7377ba8 and `acp.el` 0.15.1 against `src/shared/protocol.ts`.

ACP's own fork cannot serve agentpane: `acp-make-session-fork-request` sends `sessionId`, `cwd`, `mcpServers` and `_meta` and nothing else, so there is no fork point, and `agent-shell-fork` branches from the session as it stands.
Its forked buffer also renders no history -- the replay machinery is wired to `session/resume` and `session/load` only.
That is what OW-mutufa's case rests on, and it holds as far as the ACP channel goes.

It stops holding once the fork leaves that channel.
Nothing requires the Emacs side to fork over ACP: it can call `GET /fork-points` and `POST /fork` directly, then start a shell attached to the returned ref, and the shim serves `session/load` for it.
The replay is then the genuine truncated history, because the forked session really is the prefix -- no faking and no `_meta` extension.
Step three is `agent-shell-resume-session`, which already exists.

So the fork point is reachable from the shim stream, and this card should not be decided on it.
The model gate and `request` events are untouched by this finding and remain OW-mutufa's case.

One trap to carry into whichever stream wins.
The fork point must come from `/fork-points`, never counted from the buffer: `agent-shell-ui-state` at point yields `:namespace-id`, which is `shell-maker`'s buffer-local request counter, and `ForkPoint.index`'s docblock records that counting user messages was already falsified by Codex steering and fails silently.
Since `/fork-points` returns each point's `text`, a picker over that list is both correct and the only shape that can decline to fork on a message no point names.

## What does not map onto ACP

Named so the shim stream's cost is argued from the real list rather than from fork.

- Multi-backend identity.
  `SessionRef` is (backend, id) across pi, codex and claude in one surface; ACP is one agent per connection and `agent-shell` is one agent per buffer, so `backend` has nowhere to live but inside the id string.
- The session list.
  `SessionSummary` carries cwd, preview, createdAt, updatedAt, `status` and `isStreaming`; `agent-shell` reads `sessionId`, `title`, `cwd`, `updatedAt`, `createdAt` off ACP's, and `virtual`/`detached`/`attached` has no ACP analogue at all.
- `sessions-changed`.
  A server push that the session list changed has no ACP carrier, because ACP notifications are session-scoped; Emacs would poll.
- `renamed`.
  A session id changing under the client is the normal life of a new Pi session, and ACP has no event for it.
  A shim would have to hide it behind the stable virtual id the server already honours indefinitely on REST routes.
- Preview.
  `GET /:id/preview` is read-only and spawns nothing, which is D9's requirement that looking at a session cost what listing one costs; ACP's only way to see a transcript is `session/load`, which is an attach.
- Compaction.
  `compaction: "requesting" | "running" | null` rides on `snapshot` and `status`, and ACP has no compaction method or state.
- `issuerThreadId`, which routes a spawned Codex child's blocking request through the parent adapter, and `AssistantTurn.effort`.

## Done when

The decision is recorded in `docs/DESIGN.md` as D21, with the reason, on the same day the other stream's open cards close `--declined` citing D21.
The closing act also writes the sentence OW-basoga planned for D14, scoping it to the browser client, since it is true of both streams.
