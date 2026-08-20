---
kind: question
where: '`src/client/controller.ts:469-471` `forkAndSubmit`, `src/client/App.svelte:190` `sendLabel`, closed `docs/work/closed/OW-hezidi.md` and `docs/work/closed/OW-yudoni.md`'
---

# Submitting an edit stops the running turn on both backends as a first cut gated on OW-yudoni, which has closed — so the gate is open and nobody has taken the decision.

OW-hezidi shipped "Stop and fork": `forkAndSubmit` aborts a streaming turn
before forking it, on Pi and Codex alike. Its own words are that this is *"a
first cut chosen because it is safe on both; not stopping on Codex, where the
parent thread genuinely keeps running, is a later refinement gated on
OW-yudoni."* The comment at `controller.ts:469-471` says the same.

OW-yudoni closed on 2026-08-20 with the answer. On Pi a mid-stream fork returns
`success: true` and abandons the in-flight turn: the active file moves, the new
branch is idle and empty, and `agent_settled` arrives with no assistant text
(`docs/MANUAL_TESTING.md`, OW-yudoni). So not-stopping is not a thing Pi can be
asked for — the turn dies whether or not the client aborts it first. What the
current code buys on Pi is that the death is deliberate and visible rather than
silent.

That leaves exactly the trade OW-hezidi named and declined to take blind:

- **Keep the symmetric abort.** Both backends behave alike, the label reads the
  same, and nothing has to explain why a running turn survives on one and not
  the other.
- **Stop stopping on Codex.** The owner's stated preference in OW-hezidi, and
  free there — `thread/fork` mints a separate thread and the parent keeps
  streaming. The cost is the asymmetry OW-hezidi worried "reads as a bug", now
  known to be permanent rather than pending: Pi cannot be brought to match.

Nothing in the repo records that the gate opened. OW-yudoni's Done-when asked
for this to be settled in OW-hezidi's file, but phrased the branch over a
predicted outcome — *"if Pi **cannot** fork mid-turn"* — and the answer came
back "it can, but it kills the turn", so the condition read false and nothing
was written. OW-hezidi is closed, which is why this is its own file.

## Done when

The decision is taken and lands in `docs/DESIGN.md`, since it is a behaviour
users see rather than an implementation detail. `controller.ts:469-471` stops
citing a closed OW-yudoni as an open gate either way. If the answer is the
asymmetric one, `App.svelte:190`'s `sendLabel` needs a Codex-side label that is
not "Stop and fork", and that is a change item of its own rather than this one.
