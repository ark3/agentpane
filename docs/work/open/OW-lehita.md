---
labels: [defect]
---

# A Pi level set on resume without an entry in the session file would mislabel loaded turns after it

OW-helumu names each Pi turn loaded by `get_messages` from the `thinking_level_change` entries on the session file's active branch (`withLoadedEfforts` in `src/server/adapters/pi/reducer.ts`, called from `hydrateMessages()` in `src/server/adapters/pi/process.ts`).
That walk is only as true as the entries: a level Pi puts in force without appending an entry is invisible to it.

OW-helumu's implementer read two such paths at the source of `pi 0.87.1`, and did not run either:

- On a resume, `createAgentSession` in `dist/core/sdk.js` clamps the restored level to the model it resolves, and does not append an entry when the clamp changes it.
- A resume spawned with a level override, `--model <provider>/<id>:<level>` or `--thinking`, puts that level in force, again without an entry.

In either case a turn streamed after the resume runs at the new level, and is labelled correctly while it streams, but once reloaded by a later resume or fork it takes the stale recorded level.
agentpane's own resume spawn passes no `--model` (OW-pubulu, `docs/MANUAL_TESTING.md` "OW-pubulu"), so the exposure is a recorded model that is no longer available and falls back to another, or a session last driven from the `pi` CLI with an override.

What this is in service of: D23 in `docs/DESIGN.md`, read per turn -- a turn's label is the level in force when it ran.
Load-bearing: whether Pi 0.87.1 or later records an entry in these two cases, measured live on the home server with `pi --model openrouter/deepseek/deepseek-v4.1-flash:high`, and recorded in `docs/MANUAL_TESTING.md` with the version.
Incidental: how the adapter compensates if it does not -- for instance appending nothing and comparing the level `get_state` reports after a resume against the branch's last recorded level.

## Done when

- A live run records, with the Pi version, whether each of the two paths appends a `thinking_level_change` entry.
- If either path leaves no entry, a test in `src/server/adapters/pi/process.test.ts` reloads a turn streamed after such a resume and asserts it carries the level it ran at, shown red first; if both paths do append one, the run's record is the whole of the work, and the `withLoadedEfforts` docblock says so.
