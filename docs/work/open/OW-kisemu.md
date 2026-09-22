---
labels: [defect, emacs, emacs-native]
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
