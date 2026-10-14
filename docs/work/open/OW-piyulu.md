---
labels: [change]
blocked-by: [OW-wudija]
---

# Pi captures run with --no-session, so no Pi session file is on record and nothing holds a live Pi transcript against its stored preview

The Pi counterpart of what OW-zadupu built for Codex, filed 2026-10-14 when the home server's Pi moved to `1.2.0`.

`resources/probes/capture_fixtures.py`, `capture_pi`, spawns `pi --mode rpc --no-session`, so every Pi fixture under `resources/fixtures/pi/` is the RPC stream alone and the repo holds no session file Pi wrote.
A Codex scenario marked `rollout` in the same file's `SCENARIOS` keeps the rollout beside the stream as `<scenario>.rollout.jsonl`, and `src/server/sessions/codex-conformance.test.ts` replays the stream through the reducer and the rollout through the preview and holds the two against each other, with every known disagreement listed in `KNOWN_DIFFERENCES` under the card that owns it.
Pi has neither half.
What reads Pi's files is `src/server/sessions/pi.ts` with `storedAgentMessage` in `src/server/sessions/preview-message.ts`, and the only check of it against real files is `src/server/sessions/real-dirs.smoke.test.ts`, which asserts that the listing parses.

The cost of the gap is concrete: as of 2026-10-14 Pi session files on the home server carry `role: "system"` messages, which the preview drops and both clients dump as raw JSON live, and assistant messages carrying a `thinkingLevel` field, which `withLoadedEfforts` in `src/server/adapters/pi/reducer.ts` says `get_messages` does not have; no fixture shows either, and both were found by reading the owner's own store.

In service of D18 in `docs/DESIGN.md`, "Fixtures are the one place the first group turns into the third": a Pi fixture that keeps its file makes the on-disk shape a stamped snapshot a test runs against, as the stream already is.

## What is load-bearing

The stream and the file come from one run, so a disagreement is agentpane's and not two runs differing.
Pi writes the file under the throwaway `PI_CODING_AGENT_DIR` or a `--session` path inside the capture's own scratch, never under `~/.pi/agent/sessions`, which is the owner's store.
The file is scrubbed like the stream before it is committed, and reviewed by hand beyond that: its header carries the capture's `cwd`, and a `role: "system"` message carries the system prompt's `sections`, which may hold the contents of context files Pi loaded from the capture's working directory or the state dir; nothing private to the operator is committed.
Which scenarios keep their file is the implementer's call, but at least one has a tool call and its result, and one has a compaction.
The capture runs on the pinned model, `pi --model openrouter/deepseek/deepseek-v4.1-flash:high` (AGENTS.md, "Evidence").

## Done when

At least two Pi scenarios have a committed `<scenario>.session.jsonl` (or whatever name `resources/fixtures/README.md` then documents) captured on the installed `pi`, with the version in its `.meta.json`.
A Pi conformance test, shaped after `codex-conformance.test.ts`, replays each scenario's stream through `reducePiNotification` in `src/server/adapters/pi/reducer.ts` and its file through `extractPiPreviewTurns` in `src/server/sessions/pi.ts` and fails on any disagreement not listed in its own known-differences table, each entry naming the card that owns it; a disagreement with no card gets one filed.
That test is shown to fail when one entry is removed from the table.
`resources/fixtures/README.md` says which Pi scenarios keep their file and why.
`bun run check` passes.

Blocked by OW-wudija because that card diffs the live wire against the current Pi fixtures, and a re-capture here would replace the baseline it reads.
