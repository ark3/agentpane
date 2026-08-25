---
kind: change
where: '`src/shared/protocol.ts:57` `BackendId`, `src/server/sessions/`'
---

# Session enumeration learns Claude Code's store: `BackendId` gains `"claude"` and a `sessions/claude.ts` parser walks `~/.claude/projects/`.

Decided 2026-08-25 by the owner: Claude Code becomes a third backend, limited
functionality acceptable. This is the enumeration half; the adapter is
OW-beripo, and this item does not wait for it — `AppDeps["adapters"]` is
`Partial<Record<BackendId, AdapterFactory>>` (`src/server/http/deps.ts:67`),
so the union can grow before a factory exists. Do **not** add
`<option value="claude">` to the new-session picker (`App.svelte`, ~line 863)
here: that is OW-beripo's, because offering a backend before its adapter
exists creates sessions nothing can attach.

The store, verified on the home server 2026-08-25 against files written by
2.1.228–2.1.238: `~/.claude/projects/<munged-cwd>/<uuid>.jsonl`. The
directory name munges `/` to `-` lossily (worktree paths produce `--`), so
read `cwd` from the lines, the way `parseCodexSession` reads `session_meta` —
message lines carry `cwd`, `sessionId`, `timestamp`, `version`, `gitBranch`,
`isSidechain`, and an Anthropic-shaped `message`. One real transcript counted
156 `assistant`, 89 `user`, 22 `ai-title`, 21 `last-prompt`, 16
`queue-operation` and 16 `attachment` lines; other types (`summary` at least)
appear in other files. Skip the non-message types, skip `isSidechain: true`
lines (inline subagent transcripts), and bucket unknown shapes rather than
throw — same stance as `src/server/sessions/codex.ts` takes toward header
drift, and Claude Code versions weekly, so drift is a certainty not a hedge.

Preview: Claude injects wrapper content into user turns (`<system-reminder>`
blocks, `<command-name>` wrappers) — the same disease
`SYNTHETIC_USER_PREFIXES` in `codex.ts` treats. But `ai-title` lines carry a
generated session title, which may beat the first-human-message heuristic
outright. First cut: pick one, say which in the code and why, and let use
decide (the iterate-from-use rule).

Where it lands: `"claude"` in `BackendId`; a root in `SESSION_ROOTS`
(`src/server/sessions/index.ts`); `claude.ts` beside `pi.ts` and `codex.ts`,
wired into `listSessions`, `getSession` and `readSessionPreview`.

Done when: `src/server/sessions/claude.test.ts` (node project) exercises the
parser over synthetic store files and fails before the change; the
`real-dirs.smoke.test.ts` pattern extended to the claude root lists this
machine's real sessions; `GET /api/sessions` merges all three backends by
recency.
