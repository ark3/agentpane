---
labels: [change, emacs]
blocked-by: [OW-basoga, OW-razoki]
---

# The ACP shim advertises fork so agent-shell-fork works from the tip, and a _meta entry id plus one Emacs command forks at an earlier message

Filed 2026-09-13.
Fork is the feature that justifies the shim over `agent-shell`'s own adapters (OW-basoga), so it is the second slice rather than part of the first.

## From the tip, no elisp

`acp.el` 0f2cac4 has `acp-make-session-fork-request` (`session/fork`, marked unstable, https://agentclientprotocol.com/rfds/session-fork), and `agent-shell` 7377ba8 has `agent-shell-fork`, which starts a new shell with `:fork-session-id` when the agent's `initialize` response advertises `fork` in its session capabilities.
Both are at `~/.emacs.d/straight/repos/` on the home server.
The shim advertises the capability and implements `session/fork` by calling `GET .../fork-points` and `POST .../fork` at the last point, then answering with the new session's id, models and mode the way `session/new` does.
`agent-shell-fork`'s docstring promises "leaving the original shell intact", which is only true once OW-razoki lands: today a Claude fork kills the parent's process and re-keys its container onto the fork (OW-risuwo, OW-kekoji), so the original shell would be driving a dead session.
That is why this card waits on OW-razoki; Codex already behaves as the docstring says.

## At an earlier message

ACP's fork has no fork-point parameter, and `agent-shell` forwards only the config's static `:session-meta` on every session request.
The shim accepts `_meta.agentpane.entryId` on `session/fork` and forks there instead of at the tip.
`emacs/agentpane.el` gains one command: fetch the fork points through `acp-send-request` with an extension method the shim answers (`_agentpane/forkPoints`, returning `ForkPoint[]` from `src/shared/protocol.ts`), offer them in a `completing-read`, then call `agent-shell--start` with `:fork-session-id` and a copy of the config whose `:session-meta` carries the chosen id.
That copy is the wrinkle; keep the command short and say in its docstring why the meta rides on the config.

## Done when

On the home server against Codex: `agent-shell-fork` opens a second shell whose transcript is the parent's, both shells accept a prompt afterwards, and the new command forks at a chosen earlier message and shows only the history up to it.
A shim test asserts that `session/fork` with an entry id in `_meta` posts that id, and without one posts the last fork point.
