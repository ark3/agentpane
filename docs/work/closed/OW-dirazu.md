---
labels: [defect]
closed: done
---

# A Codex re-attach takes the running turn from the listing, and a slot opened by a delta yields to a listed copy

Filed 2026-09-25 by the adversarial read of OW-dutute, as the ownership sibling `AGENTS.md` "Evidence" asks for: OW-dutute's Codex half is a guard at the site, and the read named cases it misses.
In service of a Codex session re-attached mid-turn that looks and behaves like the running session it is.

## What OW-dutute landed

`CodexReducer.applyDelta` in `src/server/adapters/codex/reducer.ts` now opens a slot for an item it has none for, from the delta's kind (`openAgentMessage`, `openPlan`, `openReasoning`), so an item whose `item/started` went out before `CodexAdapter.adoptConnection` keeps its deltas.
`CodexReducer.hydrate` keeps any live slot over the listed copy.
The measurement it rests on is the `docs/MANUAL_TESTING.md` section for OW-dutute: as of `codex-cli 0.156.0`, `thread/turns/list` at `itemsView: "full"` taken mid-stream listed the running turn as `inProgress` with its completed items only, leaving the streaming `agentMessage` out, and `thread/resume` replayed no `turn/started` or `item/started`.

## What nothing owns

The running turn as it stood before the attach.
Nothing takes it from the listing or from `thread/resume`'s `thread.status`, so on a borrowed re-attach (`CodexAdapter.start` with a live `resumeId` → `adoptConnection` → `startBorrowed`) during a turn whose `turn/started` preceded the attach:

- `CodexReducer`'s streaming state is set only by `turn/started`, `thread/status/changed` and `turn/completed`, and `hydrate` ignores `turn.status`, so `getState().isStreaming` is false and the UI shows the session idle.
- `CodexAdapter.turnId` is set only from `turn/started` in `onServerMessage` or the `turn/start` response in `submit`, so `abort()` returns at its `if (!turnId) return;` and sends no `turn/interrupt`; `submit()` sends `turn/start` rather than steering; `compact()` passes its busy gate.
- A compaction running before the attach leaves the reducer's `compaction` null.

The reader reproduced the first two in a scratch copy: after the new `adapter.test.ts` test "keeps the deltas of an item that started before the attach (OW-zudase)", `isStreaming` was false and `abort()` wrote nothing.
That test has no `turn/started` and never asserts `isStreaming`, so it encodes this.

And the item's head.
A slot a delta opened holds only the deltas since the attach, but `hydrate` still prefers it to a listed copy on the premise that a live slot has every delta since the item began.
If the listing holds the item with its partial text, the head is lost: a reasoning item listed with `HEAD-MIDDLE-` and one `summaryTextDelta` `TAIL` arriving before hydrate shows `TAIL` after OW-dutute and showed `HEAD-MIDDLE-TAIL` on the reducer before it.
Only a streaming `agentMessage` was measured to be left out of the listing; whether a streaming `reasoning`, `plan`, `commandExecution` or `fileChange` is listed, and with what, is unprobed.
`item/commandExecution/outputDelta` and `item/fileChange/patchUpdated` still open nothing, so those items stay invisible until `item/completed`.

## What this card does

Make the listing, and the resume response if it carries it, the owner of the pre-attach turn: `hydrate` (or `startBorrowed`) takes the running turn's id, its streaming state and any running compaction from an `inProgress` turn, and the adapter's `turnId` with it.
Mark a slot opened by a delta as headless, so a listed copy of the same item wins over it and the deltas that arrived after the page are the only ones laid on top; that decides whether a delta both the page and the stream carried can be applied twice, which the measurement did not settle.
Measure first, on the home server with `codex -m gpt-5.6-luna` per `AGENTS.md`, what the mid-stream listing holds for the streaming item kinds named above and whether `thread/resume`'s `thread.status` reads `active`; `resources/probes/hydrate_window_probe.py` is the harness OW-dutute wrote for exactly this window.
Record it in `docs/MANUAL_TESTING.md` with the version.
Retire the guard it replaces by name: the unconditional "no slot, open one" in `applyDelta` and the "live slot wins" rule in `hydrate`, whichever the design no longer needs.

Load-bearing, as for OW-dutute: D20's indexes (`indexOfItem` and `hydrate` filling `slots` identically, OW-roveze), `remap` for hydrated items (OW-61), start-time `compactionTokensBefore` (OW-kelomi), nothing applied twice.

## Done when

- A test in `src/server/adapters/codex/adapter.test.ts`, in the block "re-attaching a thread whose turn is running (OW-vijuyi)", re-attaches while a listed `inProgress` turn is running and asserts `getState().isStreaming` is true and that `abort()` writes a `turn/interrupt` naming that turn; red against today's adapter first.
- A reducer test in `src/server/adapters/codex/reducer.test.ts` where the listing holds a partial item and a delta for it arrived before hydrate shows the listed head followed by what arrived after the page; red first.
- The measurement recorded with the `codex-cli` version.
- `bun run check` green.

## Close note

Landed on main in five commits (93b1c87..91e271f).

Measurement, recorded in `docs/MANUAL_TESTING.md` under "What a Codex listing holds of a running turn, by item kind (OW-dirazu)". It was taken on the home server on 2026-09-25 with `codex-cli 0.156.0` and `gpt-5.6-luna`, using `resources/probes/hydrate_window_probe.py --item <kind>`.
- Every item that was still streaming was left out of `thread/turns/list`: `agentMessage`, `reasoning`, `commandExecution` and `plan` alike.
- An item that was listed held exactly what its deltas had carried.
- No `fileChange` could be caught streaming, and no `patchUpdated` was ever sent.
- A compaction's turn was listed `inProgress` with no items at all.
- On the live app-server, `thread/resume` read the thread `{"type":"active"}` but named no turn.
- A killed app-server's turn was listed `interrupted`, and a fresh server's resume read the thread `idle`.
- No partial item was ever listed, so whether one delta can reach both the page and the stream was never observed.

Design:
- On a borrowed re-attach only, `CodexReducer.hydrate` takes the running turn from the listing's last `inProgress` turn.
  It sets streaming, sets compaction when that turn lists no items, and emits a `running-turn` effect.
  The adapter adopts that as `turnId` plus a lifecycle `turnBusy`, so `abort()` interrupts the turn, `submit()` steers it and `compact()` refuses.
- The stream wins over the listing when, during the page read, it settles the turn itself (`turn/started`, `turn/completed`, a non-active `thread/status/changed`) or sets compaction state.
  This is tracked in `pageRead`, from `pageRequested()` to `hydrate`.
- A cold resume adopts no turn, since a fresh app-server can be running none.
- A slot opened by a delta is headless (`Slot.sincePage`): a listed copy wins over it, and only the deltas that arrived after `pageRequested()` are laid on top.
- Retired: the unconditional "live slot wins" rule in `hydrate`.
  Kept: `applyDelta`'s "no slot, open one" rule, now opening a headless slot, because the listing leaves every streaming item out.
- `docs/DESIGN.md` D24 was updated, including its heading.

Verified:
- New adapter tests in "re-attaching a thread whose turn is running (OW-vijuyi)" cover streaming plus `turn/interrupt` naming the listed turn, steer and refusing compaction, the compaction signature, the cold resume adopting nothing, a turn completed during the read, and an active status arriving during the read.
- New reducer tests in "hydrate over a live stream (OW-dirazu)" check that a listed head is followed by the deltas after the page, giving `HEAD-MIDDLE-TAIL`.
- Each new test was shown red against the code before it.
- `bun run check` was green, 1374 tests in 41s.

The adversarial read found four problems, all fixed before landing:
- the cold path was adopting a ghost turn;
- the compaction rule was broader than the evidence;
- two defensive checks in the `running-turn` handler could never trigger;
- `endedTurnIds` was a guard that missed a turn ending by status change.
`endedTurnIds` was replaced by the `pageRead` ownership.

Left as documented, not fixed:
- The page edge is fixed at the moment the listing request is written. A delta that Codex also listed but that is read after that moment would be applied twice. This is unobserved, because no partial item has ever been listed; the `pageRequested` docblock says so.
- The compaction signature is a single sample, and a user turn listed before its `userMessage` is recorded would read as a compaction. That case is unmeasured.
- `commandExecution` output from before the attach stays invisible until `item/completed`, as before.
