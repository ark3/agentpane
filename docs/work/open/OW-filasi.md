---
labels: [defect]
---

# Attaching a stored Codex subagent from the picker fails on codex-cli 0.157.1, which refuses thread/resume for a sub-agent whose parent is not loaded

Filed 2026-10-01 from OW-hagito's live run; the evidence is `docs/MANUAL_TESTING.md`, "A Codex subagent's live thread holds none of the parent messages its rollout copies (OW-hagito)", under "agentpane cannot attach such a subagent at all".

## What happens

`CodexAdapterFactory.start` in `src/server/adapters/codex/adapter.ts` attaches a stored thread with `thread/resume` on a fresh app-server whenever `opts.resumeId` names a thread no shared connection holds (the `this.options.connections?.find(opts.resumeId)` branch is the only other route).
As of `codex-cli 0.157.1`, the app-server answers that `thread/resume` for a subagent thread with code -32600: `cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it`.
So attaching such a subagent from the picker fails, in both clients, since both reach the same server attach.
Measured on three subagent rollouts written by 0.153.0, 0.153.4 and 0.154.0, all depth 1; the 0.153.4 one is `~/.codex/sessions/2026/09/09/rollout-2026-09-09T22-46-19-01a08935-7d5e-7ff1-adca-be6d47a2665a.jsonl`, child of `01a0891a-fd1d-7840-a443-17526f5c406d`.
Reproduce it, as that section says, with `bun resources/probes/agentpane_codex_history_live.ts --thread 01a08935-7d5e-7ff1-adca-be6d47a2665a`, but against a throwaway `CODEX_HOME` holding copies of the rollouts, `auth.json` and `config.toml`, never `~/.codex` itself: a resume appends to the rollout it opens.

## What the run already established

On a bare app-server, `thread/resume` of the parent and then of the subagent both succeed, and `thread/turns/list` then pages in the subagent's own turns (no `userMessage` among them, which is what OW-hagito settled for the preview).
`thread/read` with `includeTurns: true` on the unloaded subagent answers `notLoaded` with no turns and no error, so it is not a read-only substitute.
A depth-2 subagent, `01a08bec-5fa0-...` (0.154.0), had its parent's resume refused the same way; going through the grandparent was not tried.
Not tried: whether subagents written by 0.157.1 itself are refused the same way, and whether a subagent opened from a live parent's subagent card (OW-benige's control) reaches it through the shared connection and so never hits this.

## What is undecided

Whether agentpane should attach such a subagent at all, and how: resume the ancestor chain on the attaching app-server first (which loads, and appends to, threads the user did not ask to open), or refuse the attach with an honest message instead of an RPC error.
Measure the open questions above first, on the home server with `codex -m gpt-5.6-luna`, naming the version, and record them under the OW-hagito section or a new one beside it.

## Done when

- The decision is recorded in `docs/DESIGN.md` with the measurement behind it.
- A test in `src/server/adapters/codex/adapter.test.ts`, whose fake app-server answers a subagent's `thread/resume` with that -32600 error as 0.157.1 does, asserts the chosen behaviour, and was watched red first.
