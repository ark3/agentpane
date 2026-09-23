---
labels: [defect]
---

# A resumed session spawns with no --model, so agentpane stops asserting the model it was given

`src/server/http/session-manager.ts` -- `#start`, its `!session` branch and the spawn's `...(bound.model ? { model: bound.model } : {})` line -- and `src/server/adapters/pi/spawn.ts`, whose `buildPiSpawnCommand` only emits `--model` when `opts.model` is set.

Observed live on the home server 2026-09-16 against `pi 0.85.1` (`docs/MANUAL_TESTING.md`, "Detach then Attach resumes a real Pi session, and the resume spawn drops the model").
A session created with an explicit model spawned as `pi --mode rpc --model openrouter/deepseek/deepseek-v4.1-flash:high`.
After a `DELETE` and a re-attach, the second spawn was `pi --mode rpc --session <path>` with no model flag at all.

The store path could not do otherwise as things stand: `SessionSummary` in `src/shared/protocol.ts` carries no `model` field, so there is nothing for the `!session` branch to restore even if it asked.
D23 in `docs/DESIGN.md` settles where the repair reads from: the model the session file last recorded, not a new summary field or a copy the manager keeps.

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
Incidental: whether the repair passes the recorded model at spawn or re-asserts it after attach via `setModel`, or, if Pi restores it itself, records that in a docblock.
Either way the resume spawn never carries the pin's `:<thinking>` suffix: OW-ruzuhu measured a suffixed `--model` on `pi 0.87.1` overriding the level the session file recorded (`docs/MANUAL_TESTING.md`, OW-ruzuhu's section).

Found alongside: `POST /api/sessions/:backend/:id/model` accepts `provider/modelId` but rejects the `:thinkingLevel` suffix that Pi's `--model` accepts, answering 500 with `Model not found: openrouter/deepseek/deepseek-v4.1-flash:high`.
That asymmetry between the two paths is a second thing, and whether it belongs to this card or its own is for whoever picks this up.

Done when a re-attached session provably runs on the model its session file last recorded, pinned by a server test, red first, that asserts what the repair relies on: the resume spawn carrying that model, or, where Pi restores it, carrying no suffixed `--model`.

Found in the same run: OW-bohodu (D9's first-prompt materialisation claim) and OW-pizaki (the `:thinkingLevel` suffix answering 500).

## The thinking-level half, settled by OW-ruzuhu

Measured on the home server 2026-09-23, `pi 0.87.1` (`docs/MANUAL_TESTING.md`, "A Pi turn at a chosen thinking level, what `set_model` does to it, and what a resume keeps (OW-ruzuhu)").
A session that chose `off` was resumed while the throwaway `settings.json` named `max` for its model and `low` as the default.
With `--session` alone, which is today's resume spawn, `get_state` read `off`: a resume keeps the level the session file last recorded, over both settings defaults.
`--model` without a suffix also kept `off`, but `--model openrouter/deepseek/deepseek-v4.1-flash:high` read `high`, so the suffix overrides the session's own level.
That constrains the fix here: a resume spawn that restores the model must pass it **without** the `:<level>` suffix, or it silently undoes the effort the user chose through OW-ruzuhu's `set_thinking_level`.
The model axis is still unmeasured.
