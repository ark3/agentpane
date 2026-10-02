---
labels: [defect, d27]
blocked-by: [OW-kametu]
---

# Whether a Codex thread has a rollout is the Codex adapter's to record and put on both wires, and the empty-transcript stand-ins for it in the name route and both clients go

Filed 2026-10-02 by the adversarial read of OW-kametu's fix, as its sibling: OW-kametu refuses a Codex rename while the transcript is empty, and this card moves that fact to its owner and retires the stand-in.

## What holds after OW-kametu

As of `codex-cli 0.160.0`, `thread/name/set` on a thread opened by `thread/start` and never prompted wrote a `session_index.jsonl` line and a sqlite `threads` row with no rollout behind them (`docs/MANUAL_TESTING.md`, "A rename before the first turn and during one, on Claude Code and Codex (OW-kametu)").
OW-kametu guards it in three places, each reading an empty transcript as "no rollout yet":

- `CodexAdapter.setName` in `src/server/adapters/codex/adapter.ts` throws `BackendRefusedError` while `this.reducer.getState().messages.length === 0`;
- `renamable` in `src/client/App.svelte` withholds Rename for a Codex session whose `selectedSession.messages` is empty;
- `agentpane--check-renamable` in `emacs/agentpane.el` refuses a Codex buffer with no indexed nodes.

The fact D9 needs is whether Codex has a rollout for the thread, and only the Codex adapter can know it; nothing records it today.
`ManagedSession.virtual` in `src/server/http/session-manager.ts` is not that owner and must not become it: `markPrompted` clears it in `submit` before the `turn/start` is admitted, and a first-message fork's container is built with `virtual: false` although that fork is a fresh `thread/start` with no rollout (`fork` in the manager).
`#liveOverlay` also reports `attached` whenever an adapter exists, so neither client can see `virtual` at all.

## Where the stand-in is wrong

- Refuses a safe rename: a rename queued behind a first prompt through `#serially` runs once the `turn/start` response resolves `adapter.submit`, which in `resources/fixtures/codex/text.jsonl` arrives before `turn/started` and the `userMessage` item, so whether the reducer holds the user message yet depends on stdout chunking; the rollout exists either way ("The rollout and the `threads` row already existed from the turn's start", OW-kametu's section).
  Only an API caller or a second client hits this; both clients withhold Rename while sending or streaming.
- Refuses a safe rename: a thread resumed from the store whose rollout pages back zero turns stays empty (`start()`'s `if (turns.length)` hydration).
  No source of such a rollout was found; it is unmeasured.
- May allow an empty write: Compact is offered with no prompted gate (`App.svelte`'s compact item, `CodexAdapter.compact`), and a `contextCompaction` marker would make `messages.length === 1` on a thread with no rollout.
  Whether `thread/compact/start` on an unprompted thread emits that item, or itself writes a rollout, is unmeasured.

## What the owner would record

A flag the Codex adapter sets when a rollout is known to exist: on `thread/resume`, on a fork that keeps turns (`startBorrowed`; Codex flushes the forked rollout before any turn), and once a `turn/start` is accepted (`responseAccepted` in `submit`).
A first-message fork goes through `thread/start` and starts without it.
It reaches the clients on both wires -- the HTTP API's session state and the Emacs helper's JSON-RPC in `src/emacs/protocol.ts` -- since both clients are first-class (AGENTS.md, "Both clients").
Load-bearing: the server's refusal and both clients' Rename gates read the same fact, and none of them reads the transcript length for it.
Incidental: the field's name and whether it rides on status or snapshot.

## Done when

1. A live run on the home server (`codex -m gpt-5.6-luna`, version named) records in `docs/MANUAL_TESTING.md`, in a section naming this card, whether `thread/compact/start` on a thread never prompted emits a `contextCompaction` item and whether it writes a rollout, an index line or a `threads` row; `resources/probes/session_name_probe.py` is the probe to extend.
   Whatever it shows, record what it means for Compact before the first prompt: if compaction alone writes the empty thread D9 forbids, refuse it the same way, under this card's tests.
2. `CodexAdapter` tests in `src/server/adapters/codex/adapter.test.ts`, each watched red first: a rename queued after a first `turn/start` is accepted but before its `userMessage` item arrives sends `thread/name/set`; a rename on a thread opened by `thread/start` and never prompted is still refused; and a first-message fork is refused until prompted.
3. `renamable` in `src/client/App.svelte` and `agentpane--check-renamable` in `emacs/agentpane.el` read the new field, with an `App.test.ts` case and a case in `emacs/agentpane-test.el`'s `agentpane-test-rename-session-refused-where-the-browser-offers-no-rename` each watched red first, in which a Codex session with an empty transcript but a known rollout is offered Rename.
4. The stand-in is gone: no `messages.length` test remains in `CodexAdapter.setName`, no transcript-length conjunct remains in `renamable` for Codex, and no ewoc node count remains in `agentpane--check-renamable` for Codex; the docblocks and the D13 sentence in `docs/DESIGN.md` beginning "A second cost, measured on 2026-10-02" name the new fact instead of an empty transcript.
