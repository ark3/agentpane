---
labels: [change, emacs]
blocked-by: [OW-fenobo]
---

# An ACP shim over the HTTP API lets agent-shell list, load, create, prompt and cancel agentpane sessions, with the model chosen only before the first prompt

Filed 2026-09-13.
The owner's goal: most of `agent-shell`'s Emacs UI without losing what agentpane provides, chiefly per-backend forking and sessions that are the CLIs' own store files, so the same conversation can be picked up from the TUI or the browser.
`agent-shell`'s own ACP adapters give neither; see OW-wawipu for why their sessions do not even reach the CLIs' resume pickers.

## Shape

An entry script under `src/acp/` that Bun runs from source, the way `src/server/index.ts` is run, speaking JSON-RPC over stdio the way `acp.el` expects.
There is no build and no binary anywhere in this repo, and the shim adds none.
It is a client of the HTTP API through `src/client/api.ts`, whose `fetch` and `openEvents` are injectable; the reducer in `src/client/session-state.ts` and the mapping from OW-fenobo do the rest.
It lives outside `src/server/` deliberately: it is a client, and D8's loopback surface stays untouched.
One shim process per `agent-shell` buffer, each holding its own event stream; the server already serves several subscribers and Bun has no per-origin connection cap.

Methods, and what each calls:

- `initialize`: advertise `loadSession` and the `list` capability, no `fork` yet (that is OW-limejo), no prompt image capability until `PromptRequest.images` is wired.
- `session/list`: `GET /api/sessions?cwd=`, mapping `SessionSummary` to ACP's session entries with `preview` as the title.
- `session/load`: `GET .../preview` for a detached session, replayed through OW-fenobo's mapping, spawning nothing; for an `attached` one, attach and replay the snapshot, since the server already holds it.
  Report the snapshot's `model` as the current model with an empty available list.
- `session/new`: `POST /api/sessions` with the backend and, when `agent-shell`'s config supplies a default model id, the optional `model`; answer with `availableModels` from `GET /api/models?backend=` and `currentModelId`, which is what `agent-shell.el` reads from the new-session response.
- `session/set_model`: allowed only while the session has no messages, forwarded to `POST .../model`; otherwise a JSON-RPC error saying the model is chosen before the first prompt.
  The browser enforces the same gate in `src/client/controller.ts` `loadModelsForSelected` and the server does not, so the shim enforces it itself.
  Owner, 2026-09-13: choosing at conversation start is required, switching later is not.
- `session/prompt`: `POST .../prompt`, then stream chunks until the turn ends; a prompt while a turn is active returns the server's rejection as the error (D16).
- `session/cancel`: `POST .../abort`.
- `session/request_permission` is never issued; there are no permission prompts (D2a as decided in OW-yikoyo).

The event stream is opened on attach and carries every rule the browser learned: re-key on `renamed`, re-snapshot on a `seq` gap, and treat REST and SSE as unordered (D2).
Backend choice rides on the shim's command line, with one `agent-shell` config per backend the way `agent-shell-pi.el` names `pi-acp`, or in the `_meta` that `acp-make-session-new-request` accepts; pick one and say why in the docblock.

## Emacs side

One file, `emacs/agentpane.el`, defining the `agent-shell` config that names the shim command, the way `~/.emacs.d/straight/repos/agent-shell/agent-shell-pi.el` does for `pi-acp`.
No other elisp.
`agent-shell-session-restore-verbosity` set to `full` is what turns `session/load` into the fast-preview feature; note it in the file's commentary.

## Docs

Record the decision in `docs/DESIGN.md` as D20: the Emacs client is `agent-shell` over an ACP shim that is a client of the HTTP API, with the reasons above.
Add one sentence to D14 scoping it to the browser client, since an Emacs client is keyboard-first by nature and the rule as written reads as contradicting it.
Note in `AGENTS.md` under Code that `src/acp/` runs in node and imports client modules by design.

## Done when

On the home server, in `agent-shell` with the config from `emacs/agentpane.el`: pick a stored Codex session and see its transcript with no child process spawned (check `ps` or the server log), then send a prompt on a new session created with a chosen model and watch the reply stream in.
`src/acp/` tests cover the stdio loop against an injected fetch and event source: list, load without attach, the model gate rejecting after the first message, and a prompt whose events arrive before the POST resolves.
`bun run check` passes; `bun run test:browser` is not involved.
