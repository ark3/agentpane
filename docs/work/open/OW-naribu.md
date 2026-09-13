---
labels: [defect]
---

# agentpane cannot spawn any backend on the home server: the spawn path runs `direnv`, which is not installed there

Filed 2026-09-13, reproduced against the running app on the home server while trying to satisfy OW-razoki's live-run condition.

Every backend spawns through `direnv`.
`buildClaudeSpawnCommand` in `src/server/adapters/claude/process.ts` returns `{ command: "direnv", args: ["exec", cwd, "sbox", "--", "claude", ...] }`, and the same shape is in `src/server/adapters/pi/spawn.ts` and `src/server/adapters/codex/process.ts`.
`src/server/adapters/types.ts` states it as the contract: "Spawn via `direnv exec <cwd> sbox -- <agent>` (D7)."

## The reproduction

`bun run start` on port 4319, then `POST /api/sessions {cwd: <a fresh git repo under /var/tmp>, backend: "claude", model: "haiku"}`, then `POST /api/sessions/claude/<id>/prompt`.

The prompt returns HTTP 500:

```
{"error":"internal_error","detail":"Failed to spawn Claude Code (direnv): Executable not found in $PATH: \"direnv\""}
```

and the server's terminal carries the same line, which is OW-yeboje's logging working as intended.

## What is and is not established

`direnv` is absent from `/usr/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`, `~/.nix-profile` and the nix default profile.
There is no `~/.config/direnv`, and this repository has no `.envrc` at all -- so even with the binary present, `direnv exec` here would load no environment.
`sbox` is present at `~/.local/bin/sbox` and works: `sbox --dry-run -- claude --version` reports `adding claude args: --permission-mode bypassPermissions`.
`claude` is present and reports `2.1.268`.

The one caveat on the search: the session that ran it was inside the bubblewrap sandbox `sbox` provides, so the `$PATH` it saw is the sandbox's.
The absence of the config directory and of any `.envrc` is the stronger evidence, since neither depends on `PATH`.

Note that OW-beripo drove a full live turn through the real server on this machine on 2026-08-25, so this path worked then.
Nothing in the deck records it being removed.

## Why it matters beyond one card

Every done-condition in the deck that says "confirm it live on the home server" is unmeetable until this is settled, which is not a property any of those cards states.
OW-razoki is the one that hit it; it is blocked on this card and carries only its live-run limb.
The probes under `resources/probes/` are unaffected -- they spawn the CLI directly, which is why `docs/MANUAL_TESTING.md` records that OW-japuzo's probe "spawns `claude` directly" and passes `--permission-mode bypassPermissions` by hand, "because `direnv` is not on PATH on the home server".
That sentence, written 2026-09-11, is the same fact seen from the probe side and nobody carried it across to the server's spawn path.

## The decision, which is the owner's

Two resolutions, and this card closes when one is recorded:

- Install `direnv` on the home server, and give the repository the `.envrc` that `direnv exec` is there to load.
  This is provisioning, in the same class as installing card or Bun, and is the owner's to do rather than a session's.
- Or decide the sandboxed spawn path does not require `direnv` on a machine that has no per-directory environment to load, and let D7's path fall back to `sbox -- <agent>` when it is absent.
  This is a change to D7 and wants a decision recorded in `docs/DESIGN.md`, not a quiet fallback in three adapters.

## Done when

Either `direnv` is present and the reproduction above returns a streamed turn instead of a 500, or `docs/DESIGN.md` records the decision that D7's path no longer requires it and the spawn builders match that.
