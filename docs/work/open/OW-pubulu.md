---
labels: [defect]
---

# A resumed session spawns with no --model, so agentpane stops asserting the model it was given

`src/server/http/session-manager.ts` -- `#start`, its `!session` branch and the spawn's `...(bound.model ? { model: bound.model } : {})` line -- and `src/server/adapters/pi/spawn.ts`, whose `buildPiSpawnCommand` only emits `--model` when `opts.model` is set.

Observed live on the home server 2026-09-16 against `pi 0.85.1` (`docs/MANUAL_TESTING.md`, "Detach then Attach resumes a real Pi session, and the resume spawn drops the model").
A session created with an explicit model spawned as `pi --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash:high`.
After a `DELETE` and a re-attach, the second spawn was `pi --mode rpc --session <path>` with no model flag at all.

The store path could not do otherwise as things stand: `SessionSummary` in `src/shared/protocol.ts` carries no `model` field, so there is nothing for the `!session` branch to restore even if it asked.
That is the useful half for whoever fixes this -- the repair needs either a new summary field or the manager retaining the closed record's model, not a read off the index.

This is structural, not a fluke of that run.
`close()` drops the session from the manager's table, so the re-attach takes `#start`'s `!session` branch, which rebuilds the record from the index with `fromStore: true`, `lastModel: null` and no `model` field; the spread that would pass the model then contributes nothing.
Any re-attach reaches this, not only one following a Detach -- D12's reaper (OW-33) will make it the common path once it lands, which is when a user's chosen model silently reverting stops being obscure.

What the run did **not** establish, and what someone has to measure before choosing a fix: what the resumed process actually ran on.
Two candidates and the run cannot separate them, because `~/.pi/agent/settings.json` happened to hold the same model the flag had asked for: Pi may resolve the model from the `model_change` entry it replays out of the session file, or it may fall back to that settings default.
The run could not have detected a difference on either axis: the settings file held the same model *and* the same `thinkingLevel: high` the flag had asked for.
So the follow-up has to set a deliberately different default before the resume spawn, then read back which model answered -- `get_state`, or the per-message `provider`/`model` fields.
Without that, whoever picks this up repeats the 2026-09-16 run and learns the same nothing.
If the log wins, this is a narrower defect than it looks and the repair is to say so in a docblock; if settings win, agentpane is handing the user's model choice to a file it does not control.

Load-bearing: that the model is dropped on the resume spawn, which is proven.
Incidental: whether the repair threads the model through the store path, re-asserts it after attach via `setModel`, or records the backend's replay as sufficient.

Found alongside: `POST /api/sessions/:backend/:id/model` accepts `provider/modelId` but rejects the `:thinkingLevel` suffix that Pi's `--model` accepts, answering 500 with `Model not found: openrouter/deepseek/deepseek-v4.1-flash:high`.
That asymmetry between the two paths is a second thing, and whether it belongs to this card or its own is for whoever picks this up.

Done when a re-attached session provably runs on the model it was created with, pinned by a server test that asserts the resume spawn's argv carries `--model` -- red first.

Found in the same run: OW-bohodu (D9's first-prompt materialisation claim) and OW-pizaki (the `:thinkingLevel` suffix answering 500).
