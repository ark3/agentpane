---
labels: [unverified]
---

# A fork inside a Pi process spawned with a suffixed --model may put that level back in force without recording it

Read at the source of `pi 0.87.1` by OW-lehita's adversarial reader, and not run.

A fork in `pi --mode rpc` rebuilds the session through `createRuntime` in `dist/main.js` (around "const createRuntime = async"), which passes `createAgentSessionFromServices` the options parsed from the process's original command line: `model: sessionOptions.model` and `thinkingLevel: sessionOptions.thinkingLevel`.
`createAgentSession` in `dist/core/sdk.js` prefers `options.model` over the branch's model ("let model = options.model;"), and `options.thinkingLevel` over the branch's recorded level, appending no `thinking_level_change` for either (OW-lehita's section of `docs/MANUAL_TESTING.md`).

agentpane spawns a fresh Pi session with `--model <bound.model>` (`src/server/http/session-manager.ts`, the spawn beside "A resume carries no model, by D23"; `src/server/adapters/pi/spawn.ts`), and passes the string whole, a thinking-level suffix included ("Model refs" in `src/server/adapters/pi/protocol.ts`).
So a session created on `openrouter/deepseek/deepseek-v4.1-flash:high`, given another level by `setEffort` before its first prompt, may run every turn after an in-process fork at `high`, with the file still naming the chosen level: the running process shows one level, and a later reload labels those turns with the other.
An unsuffixed `--model` would snap the model back to the spawn model after a `set_model`, which the model gate (D23) should make unreachable after the first prompt; the level clamp OW-lehita landed then labels those turns correctly.

In service of D23 in `docs/DESIGN.md`: a conversation's effort is fixed after its first prompt, and a turn's label is the level it ran at.
Load-bearing: whether `pi 0.87.1` or later, spawned with a suffixed `--model` and given `set_thinking_level` to another level, reports that level from `get_state` after `fork`, and what the turn after the fork runs at.
Incidental: the remedy, for instance stripping a trailing level from `bound.model` into a `set_thinking_level`, or re-asserting the chosen effort after a fork as the Codex adapter does after a resume.

## Done when

- A live run on the home server, with `pi --model openrouter/deepseek/deepseek-v4.1-flash:high` and the throwaway `PI_CODING_AGENT_DIR` method of OW-pubulu's section of `docs/MANUAL_TESTING.md`, records with the version what `get_state` and the session file show after such a fork.
- If the level snaps back, a test in `src/server/adapters/pi/process.test.ts` forks a session spawned with a suffixed model after `setEffort`, and asserts the level in force after the fork is the chosen one, shown red first; if it does not, the run's record is the whole of the work.
