---
labels: [unverified, emacs]
---

# agentpane-created Claude sessions are hidden from the claude --resume picker by their sdk-cli entrypoint, while its Codex sessions show up as vscode

Filed 2026-09-13 while asking why sessions started from `agent-shell`'s own ACP adapters never appear in the CLIs' resume pickers.
The mechanism turned out to apply to agentpane's own sessions on one backend, and the "hop to the TUI" story this project tells reads as symmetric when it is not.
Read from binaries and store files, not yet run.

## What was read

Claude Code 2.1.268 tags every store line with `entrypoint`, and its resume picker filters on it.
The embedded code, found with `strings` over `~/.local/share/claude/versions/2.1.268`, reads:

    Slt = new Set(["sdk-cli","sdk-ts","sdk-py"])
    if (!D && Slt.has(o.entrypoint ?? "")) return t(`Session ${e.sessionId} filtered from /resume: entrypoint=${o.entrypoint}`), null;

where `D` is true only when the picker itself runs under an SDK entrypoint.
`claude -p`, which `src/server/adapters/claude/` spawns, tags its lines `sdk-cli`; the home server's `~/.claude/projects/-home-ark3-projects-agentpane/` holds 4,831 `sdk-cli` user lines against 79 `cli`.
The same code sets `sdk-cli` even when `CLAUDE_CODE_ENTRYPOINT=cli` is in the environment and print mode is on, so the tag cannot be spoofed from the spawn.
`claude --resume <uuid>` takes the id directly and is not the picker.

Codex rollouts carry `source` in their header.
`resources/codex-protocol/v2/ThreadListParams.ts` says the list "defaults to interactive sources" when none are named, and `codex resume --help` (0.154.0) says "Resume a previous interactive session" with `--all` lifting only the cwd filter.
As of `codex-cli 0.154.0` the app-server records agentpane's threads as `source: "vscode"`, which is interactive: 32 such rollouts on the home server against 3 `cli`.
Upstream closed the `agent-shell`-shaped report as not planned: https://github.com/openai/codex/issues/11183.

## Done when

Both halves are run on the home server and recorded in `docs/MANUAL_TESTING.md` with the versions: `claude --resume` (`--model haiku`) in the agentpane workspace does not list a session agentpane created and does open it by explicit id, and `codex resume` (`-m gpt-5.6-luna`) does list one.
Whatever the answer, D9's REST-surface paragraph in `docs/DESIGN.md` and the OW-hezidi-era "all three CLIs" wording get a sentence saying which pickers can see agentpane's sessions, so the next reader does not take the hop for granted on Claude.
If the run overturns either reading, this card's own text is one of the copies to retire.
