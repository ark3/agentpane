# Environment

Where agentpane runs and is developed, and what each machine will cost you if you do not know it.
`AGENTS.md`, "Machines", gives the short version.

## Cloud containers

A claude.ai cloud container is a fresh clone in a throwaway container, so the work in it lands differently (`AGENTS.md`, "Landing work") and some of it cannot be done there at all.
As of 2026-11-18:

- **No Codex, Pi or Emacs.**
  Live backend experiments, the probes in `resources/probes/`, and the ERT suite belong on the home server.
  The `claude` binary present is the session's own harness, not a backend to experiment on.
  Installing a distribution's Emacs would not help: the owner runs Emacs 31 and agentpane-mode uses its features.
- **`card` and `deck` are not installed.**
  `bun install -g github:ark3/card` installs both (card's `BRIEF.md`, as of 2026-11-13).
- **`gh` is installed, but the session allows it only for search.**
  Other GitHub operations go through the session's GitHub tools.
- **The browser suite cannot launch as checked in.**
  On 2026-11-18, `@playwright/test 1.62.1` wanted `chromium_headless_shell-1234`, the container shipped only `-1243` under `/opt/pw-browsers`, and downloading browsers there is not allowed.
  Run it through an uncommitted config that spreads `playwright.config.ts` and sets `use.launchOptions.executablePath` to `/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`, or whatever that directory holds then; so run, all 29 tests passed.
  The directory layout itself moves between container images: on 2026-10-02 the build was `-1194` and the binary sat at `chrome-linux/headless_shell`.

## Home server

agentpane is developed most on the home server, by Claude Code, and Claude Code, Codex and Pi are all installed there, each pinned to one model (`AGENTS.md`, "Evidence").
Live backend evidence, the probes and the Emacs client's tests are produced here.

- **Home server sandbox.**
  The home server's session environment runs inside a bubblewrap sandbox (`~/bin/sbox`); most of the filesystem is read-only.
  `~/projects/agentpane` was granted write access specifically for this work.
  If you can write elsewhere in `$HOME`, the sandbox is off — warn the user.
  One consequence bites dispatch: a dispatched worktree must live *inside* the repo tree (`.worktrees/<id>`, gitignored), because it is the only path mounted read-write — a worktree anywhere outside it (`~/src/`, `/tmp`, a sibling of the repo) fails with `Read-only file system`.
  See `AGENTS.md`, "Worktrees".
- **Each backend needs a writable state directory, and whether a session has one depends on how it was launched.**
  Codex initializes a sqlite state runtime under `~/.codex`; Pi takes a lock under `~/.pi/agent` merely to *read* its credential store and its settings.
  Both of those directories were read-only until the owner widened the sandbox on 2026-09-13, and `~/.claude` came with them; `$HOME` itself is still read-only, so the sandbox is still on and that test for it still holds.
  That widening holds for a session launched with a profile that mounts them; as of 2026-10-14 a session started as plain `sbox claude` did not, and found `~/.pi/agent` read-only (OW-robozi; `AGENTS.md`, "Do not assume how your session was launched").
  Measured after the change (OW-vowire, `pi 0.85.1`, `codex-cli 0.154.0`): `pi --mode rpc` against the real `~/.pi/agent` resolves its configured model and runs a turn to `stopReason: "stop"`, the same through `sbox --` from the repo root, and `codex app-server` starts with no sqlite error.
  The sbox note below, which says its `pi` and `codex` profiles mount those directories rw, no longer contradicts this bullet — it did until that date, when the outer namespace was mounting them read-only underneath it.
  **What was true before 2026-09-13**, and is why the probes are built the way they are: both directories were read-only, running through `sbox` did **not** fix it (an inner bubblewrap cannot re-mount read-write what the outer namespace mounted read-only), `sbox -- codex app-server` failed with `failed to initialize sqlite state runtime`, and `sbox -- pi --mode rpc` returned `stopReason: "error"` with `EROFS ... auth.json.lock`.
  The workaround those runs used, which `capture_fixtures.py` still implements, is a throwaway state dir per backend with credentials copied in: `CODEX_HOME` for Codex, **`PI_CODING_AGENT_DIR`** for Pi (Pi's exact equivalent — see `ENV_AGENT_DIR` in `pi-coding-agent/dist`).
  Keep it for anything that must not touch the real session corpus or credentials — `fork_probe.py` uses it for that reason, not for this one.
  A failure of this kind is quiet and looks like success: the turn "completes" in under a second with `stopReason: "error"` and empty content, which is what to suspect first if a backend regresses here.
  It is how `resources/probes/agentpane_codex_smoke.py` drove a real Codex through the built server, and how finding 34 was settled.
- **Pi's default model.**
  Pi reads its own default from `~/.pi/agent/settings.json`, which the owner may edit at any time — measured there on 2026-09-13, after the sandbox was widened to mount that directory read-write, `get_state` reported `deepseek/deepseek-v4.1-flash` at `thinkingLevel: "high"` both directly and through `sbox` (`docs/MANUAL_TESTING.md`, "Pi arrives on the home server").
  Earlier that same day the directory was read-only, and Pi — unable to take the lock it needs merely to *read* that file — resolved no model at all, answering `get_state` with `"id": "unknown"`.
  That is the failure `AGENTS.md`'s model flag exists to make impossible, and it is why the flag stays mandatory even where the file is readable.
- **`direnv` is the first link in every spawn, and the home server did not have it until 2026-09-13.**
  All three backends spawn as `direnv exec <cwd> sbox -- <agent>` (D7, and `src/server/adapters/types.ts` states it as the contract), so without `direnv` on `PATH` the first prompt fails with HTTP 500 and `Failed to spawn <backend> (direnv): Executable not found in $PATH: "direnv"` -- every backend, not one.
  The home server now has the real thing, `direnv 2.37.1` at `/sbin/direnv`, installed by the owner on 2026-09-13 (OW-naribu).
  Verified through the production shape: `direnv exec /home/ark3/projects/agentpane sbox --dry-run -- claude --version` exits 0 and prints the `bwrap` line with `--permission-mode bypassPermissions` injected.
  This repository has no `.envrc` and needs none -- `direnv exec` against a directory without one runs the command and loads nothing.
  **Before that date, every live run on this machine went through a pass-through shim**, `/tmp/ow-derewo-bin/direnv`, which dropped `exec <dir>` and exec'd the rest; runs recorded in `docs/MANUAL_TESTING.md` before 2026-09-13 either used it, invoked the agent directly, or say which.
  Read those sections' "the home server has no `direnv`" as true of their date, not of yours.
- **Never match a live-run's agent processes by name: the agent driving the run has the same name.**
  A live run spawns `claude` or `codex` children through agentpane, and the session measuring them is itself a `claude` or `codex` process on this machine.
  `pgrep claude` counts the measurer, so an overlap count taken that way proves nothing, and `pkill claude` kills the measurer -- which is how OW-razoki's live run ended its own session on 2026-09-13.
  Count and signal by the `--session-id` values the run put under test, which are yours and nobody else's.
  Do not reach for a name filter plus "the newest N": the measuring session is often the newest.
  **Do not count on the sandbox to contain this.**
  That session survived reaching only itself because it ran one `bwrap` deeper than its siblings -- measured the same day: its inner `claude` sat in PID namespace `4026532772` while a sibling agent session two days old, and the outer wrapper of the session itself, shared `4026532490`.
  Sessions at that outer level see each other, so the same `pkill` run from one of them takes out the others.
- **`sbox` refuses a `cwd` it cannot detect a workspace for, and a scratch directory under `/tmp` is exactly that case.**
  Measured on the home server 2026-09-16 driving a live Pi session with its `cwd` at `/tmp/ow-resume-probe` (`docs/MANUAL_TESTING.md`, OW-jamoyi); `sbox` carries no `--version`, so which build this was is not recorded.
  `direnv exec /tmp/ow-resume-probe sbox --dry-run -- pi --version` failed with `Could not detect workspace`, listing the three things it tries in order: the `--workspace` flag, then the marker files `.sandbox-workspace`, `.sandbox-root`, `.sandboxrc`, `.workspace-root` and `WORKSPACE`, then a git root.
  `touch /tmp/<dir>/.sandbox-workspace` is enough and the spawn then works, nested inside the session's own sandbox, `pi --version` answering `0.85.1` through it.
  The repo's own tree never hits this because it is a git root, so a live run pointed anywhere else is where it surfaces -- and it surfaces before the backend is reached at all, so the error names sbox and says nothing about the agent.

## Work laptop

agentpane is used most on the work laptop, with Pi and Codex.
Since 2026-10-14 no agent session develops it there: work is planned and executed on the home server, and a work-laptop item is one the owner carries out by hand (`AGENTS.md`, "Machines").

- **What still takes a visit is that machine itself.**
  Live Pi evidence was, until 2026-09-13, the main reason to go there; it no longer is, and an issue asking for one belongs wherever the session is.
  What remains is that clone's own provisioning, as in OW-gabemi, the reference material below, and that machine's own session stores, where the owner uses agentpane daily and which therefore hold the most real use (OW-furivo).
- **Its CLIs match the home server's.**
  The owner updates every CLI to its latest release on both machines each morning, so as of 2026-10-14 a version measured on the home server is the version the work laptop runs that day.

### Reference material

The absolute paths below are evidence addresses on the work laptop, not portable setup instructions.

- **pipane** (server architecture to emulate, client stack to skip; Pi-only, old scope): `/home/asa0717/src/pipane`
  - `src/server/pi-launch.ts` — the executable-resolution seam (this is where sbox slots in)
  - `src/server/process-pool.ts`, `attached-session.ts` — subprocess lifecycle / session-to-process binding
  - `src/client/fork-modal.ts`, `session-picker.ts` — fork UI, session list
  - `src/client/tool-renderers.ts` — 663 lines of coding-tool renderers, the clearest evidence for how much of this is ours to write either way
  - Superseded by DESIGN decisions, useful only as contrast: `src/server/ws-handler.ts` + `src/client/ws-agent-adapter.ts` (its WebSocket RPC — D2 chose SSE and REST over it, and D31 later one WebSocket of agentpane's own), `src/shared/jsonl-sync.ts` (SHA-256 delta sync — unnecessary on loopback, D3), and `patches/@mariozechner+pi-web-ui+0.55.3.patch` (see finding 14).
  - **Borrow patterns, not files.**
    The client stack diverges entirely, and the server-side API has drifted ~20 minor versions.
- **sbox** (the sandbox): `/home/asa0717/src/sandbox/sbox`.
  Has `pi` and `codex` profiles already (mounts `~/.pi/agent` / `~/.codex` rw), auto-detects the workspace (git root / marker), injects `codex --sandbox danger-full-access` so Codex doesn't run its own sandbox — but that flag is a no-op for `app-server`: as of `codex-cli 0.154.0` (2026-09-12, OW-pibivi) a bare `thread/start` reported `readOnly` with the flag and without it alike, and a bare `thread/fork` reports `workspaceWrite` instead (OW-18), so the effective policy is set by the adapter on each of `thread/start`, `thread/resume` and `thread/fork`, alongside `approvalPolicy: "never"` (OW-37, OW-18, D7a).
  Uses `--ro-bind / /` + `--share-net` (so Codex loopback works, but there is no network isolation and full-home read exposure — a known gap, not this project's problem).
- **`sandboxed-pi`**: `/home/asa0717/.local/bin/sandboxed-pi` — `exec direnv exec "$(pwd)" sbox -- pi "$@"`.
  Read it for the pattern only: the direnv step loads per-workspace env (API keys/model config) before entering the jail. agentpane does **not** call this script — the server builds `direnv exec <workspace> sbox -- <agent>` itself (D7), and there is no `sandboxed-codex` equivalent on PATH anyway.
- **omnigent** (reference only, do not depend on it): `/home/asa0717/src/omnigent`.
  It solves a much larger multi-agent/enterprise problem; its Codex integration (`omnigent/codex_native_app_server.py`) is a worked example of driving `app-server`, but you now have the official generated bindings, so prefer those.
- **Pi packages** (current scope, on disk): `/home/asa0717/.bun/install/global/node_modules/@earendil-works/`
  - `pi-coding-agent/docs/rpc.md` — the full Pi RPC protocol (authoritative)
  - `pi-coding-agent/docs/sdk.md` — the in-process SDK (NOT used here; we spawn subprocesses for sandboxing — see DESIGN non-goals)
  - `pi-agent-core/dist/types.d.ts` — `AgentMessage`
  - `pi-ai/dist/types.d.ts` — `UserMessage`/`AssistantMessage`/ `ToolResultMessage` and the content blocks (`text`, `thinking`, `toolCall`, `image`)
  - `pi-agent-core/dist/agent.d.ts` — the `Agent` class we deliberately do *not* implement (finding 9)
  - `pi-web-ui` is **not** installed and is not a dependency.
    To re-check any finding about it: `npm pack @earendil-works/pi-web-ui@0.75.3`.
