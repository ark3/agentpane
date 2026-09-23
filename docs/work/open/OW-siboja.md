---
labels: [defect]
---

# The session index and the preview read ~/.codex/sessions directly and ignore CODEX_HOME

`src/server/sessions/index.ts` hard-codes `DEFAULT_CODEX_ROOT = join(homedir(), ".codex", "sessions")`, and `src/server/sessions/preview.ts` falls back to `SESSION_ROOTS.codex`.
Codex itself writes its rollouts under `$CODEX_HOME/sessions` when that variable is set.
So with a non-default `CODEX_HOME`, agentpane lists none of the operator's Codex conversations, and a `DELETE` then re-attach of a conversation it created answers 404.

Observed during OW-kokalo's live run on the home server, 2026-09-23, `codex-cli 0.156.0`: that run pointed `CODEX_HOME` at a temporary directory because `~/.codex` was read-only in the session's sandbox, and the re-attach answered 404 for exactly this reason (`docs/MANUAL_TESTING.md`, "A Codex turn at a chosen reasoning effort, and what a resume keeps of it (OW-kokalo)", the paragraph opening "A resume in a fresh app-server reports the default").

`src/server/adapters/codex/process.ts` says sbox's `codex` profile mounts `~/.codex`; whether a non-default `CODEX_HOME` survives into the sandboxed app-server at all belongs to whoever works this, and decides whether the fix is to honour the variable or to record that agentpane supports only the default location.

## Done when

- A test with `CODEX_HOME` set asserts the index lists a rollout written under `$CODEX_HOME/sessions`, and the preview reads it, shown red first -- or the decision to support only `~/.codex` is recorded in `docs/DESIGN.md` beside the session index.
