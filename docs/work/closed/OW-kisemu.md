---
labels: [defect, emacs, emacs-native]
closed: done
---

# agentpane-set-model reads models/list before attaching, which Codex and Pi refuse with no live adapter, and an empty completion sends "" as the model

Found 2026-09-22 by the adversarial read of OW-gunuke's change, reasoned from the server code and not run live.

`agentpane-set-model` in `emacs/agentpane.el` calls `agentpane--read-model` in its `interactive` spec, before the body's `agentpane--attached-then` attaches the buffer.
The server answers `GET /api/models` from a live adapter if one exists and otherwise from an unstarted one (`listModels` in `src/server/http/app.ts`, "Prefer a live adapter"); an unstarted Codex adapter throws "codex adapter not started" and an unstarted Pi one "Pi process is not running".
So `M-x agentpane-set-model` on a created but never-prompted session that is not attached fails whenever no other session of that backend is live — after a server restart, for one.
`agentpane-new-session` avoids this by attaching before it reads the model; its docstring says why.

Separately, `completing-read` with REQUIRE-MATCH `t` still returns `""` on an empty `RET`.
At the model prompt that `""` reaches `sessions/setModel`: at 2026-09-22 the server checks only its type, Codex stores it and falls back to its default while reporting `""` (so the mode line shows an empty field), and Claude Code and Pi error.

## Done when

An ert test in `emacs/agentpane-test.el`, stubbing `agentpane--request` and `jsonrpc-request` with `cl-letf` as `agentpane-test-set-model-only-before-the-first-prompt` does, calls `agentpane-set-model` interactively (`call-interactively`) on an empty, unattached buffer and asserts `sessions/attach` is sent before `models/list`; it fails before the fix.
An empty model choice sends no `sessions/setModel`; an ert test asserts that too.

## Close note

Landed on main as e1bb87e and 62cdc7f, in `emacs/agentpane.el` and `emacs/agentpane-test.el`.

- `agentpane-set-model`'s `interactive` spec now attaches an unattached buffer synchronously before `agentpane--read-model`, through `agentpane--attach-now`, the synchronous attach factored out of `agentpane-new-session` unchanged (up to `agentpane--spawn-timeout`, rekey from the reply).
  Synchronous rather than prompting from inside a jsonrpc callback, for the reason `agentpane-new-session` already gave.
- An empty model choice (an empty `RET` at a REQUIRE-MATCH `completing-read`) sends no `sessions/setModel` and the session keeps its model; a silent no-op rather than a user-error, since `agentpane-new-session` reaches it after the session exists and an empty `RET` there means "keep the default".
  Read from the adapters at daf5f52: Codex stores `""` and runs on its default while reporting `""`, Pi's `splitModelRef` throws on it, and Claude passes it to the CLI as is — the card's "Claude Code errors" was not confirmed from our code.

Verified by ert, 31/31 on Emacs 31.1: `agentpane-test-set-model-attaches-before-listing-models` was red on the old code with (models/list sessions/attach sessions/setModel), and `agentpane-test-set-model-empty-choice-sets-nothing` was red with a `sessions/setModel` sent.
Not run live against a server restart.

The synchronous attach does not consult `agentpane--attaching`, so it can send a second attach beside a first prompt's; recorded on OW-yibimi.
