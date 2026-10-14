---
labels: [change]
blocked-by: [OW-wudija]
closed: done
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

## Close note

Two Pi scenarios now keep the session file Pi wrote beside their RPC stream, and a conformance test holds one against the other.

`resources/probes/capture_fixtures.py` gained a `session` flag: such a Pi scenario runs with `--session-dir` inside the throwaway `PI_CODING_AGENT_DIR` instead of `--no-session`, keeps the one file as `<scenario>.session.jsonl`, scrubbed by key against the stream, with `session_census` in its meta.
Every Pi line now also has the operator's home replaced by `/example-home`, because as of `pi 1.2.0` the leading system message's `docs` section names Pi's install path.
`tool-read-session` (a tool call and its result) and `compact-session` (two turns then a manual compaction) are new Pi-only scenarios, captured 2026-10-14 on `pi 1.2.0` pinned to `openrouter/deepseek/deepseek-v4.1-flash:high` (`models_seen` confirms it); they are new rather than re-captures of `tool-read` and `compact`, whose 0.84.x streams `reducer.test.ts` and several docblocks cite, so no existing fixture or test changed.
`~/.pi/agent/sessions` listed identically before and after the run, and the six new files grep clean of the username, home roots, hostname and keys; the system message's `sections` held only Pi's own preamble, tools, rules, docs and cwd.

`src/server/sessions/pi-conformance.test.ts` replays each stream through `reducePiNotification` (skipping `response` lines, as `process.ts` does, and seeding the effort `get_state` would) and each file through `extractPiPreviewTurns`, projected after `codex-conformance.test.ts`, whose `hunks` moved to `src/server/sessions/conformance-support.ts` for both to share.
Its table lists two disagreements: every assistant turn names `effort=high` live and nothing in the preview, because `storedAgentMessage` keeps `thinkingLevel` but never names it as `effort` (OW-zarine, amended to own the preview half), and live draws a `compactionSummary` marker the preview never does, because Pi stores a compaction as a `type: "compaction"` entry and `extractPreviewTurn` reads only `message` entries (filed as OW-livowu).
Verified by the dispatching session: green as landed, red with one `tool-read-session` entry removed.
The adversarial read found a third disagreement the projection left out, the assistant footer's time (the preview uses the entry's append time, the message keeps its start), filed as OW-jiwaso and named in the test header; and it found the reducer's "Pi's messages carry none" overturned for the live stream on 1.2.0, versioned in place and pointed at OW-zarine.
Not acted on, from that read: the test asserts no table entry's `owners` and no shared rows, so a regression both sides share passes, as in the Codex test; the replay hands `thinking_level_changed` to the reducer where `process.ts` intercepts it, harmless while no capture contains one; and `model_change.modelId` is scrubbed only because the same model also appears at a scrubbed key.
`resources/fixtures/README.md`, "The session-file scenarios", and `docs/MANUAL_TESTING.md`, "Pi fixtures that keep their session file (OW-piyulu)", record the runs. `bun run check` passed.
