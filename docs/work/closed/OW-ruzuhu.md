---
labels: [change]
blocked-by: [OW-kokalo]
closed: done
---

# Pi conversations get the effort picker, set through set_thinking_level before the first prompt

OW-kokalo lands the effort contract on both wires, the HTTP API and the Emacs helper's JSON-RPC, with Codex behind it and no client UI; OW-kivahe and OW-vozaku are the browser and Emacs controls.
This card fills in Pi's adapter, so both clients offer Pi effort without either changing.

## What Pi offers

As of `pi 0.87.1`, per its installed `docs/rpc-commands.md` under "Thinking" (on the home server at `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/`):

- `set_thinking_level` takes one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `xhigh` and `max` only where the selected model supports them.
- `get_available_thinking_levels` lists the levels for the *current* model, and answers `["off"]` for one without reasoning.
- `get_state` reports `thinkingLevel`; `docs/json.md` lists a `thinking_level_changed` event; `docs/session-format.md` shows a `thinking_level_change` session entry.
- At spawn, `--thinking <level>` or a `:<thinking>` suffix on `--model` (`pi --help`).

These come from Pi's docs, not a live run.

## Where it goes

`src/server/adapters/pi/process.ts` (`setModel`, `listModels`, `modelToInfo`) and `src/server/adapters/pi/protocol.ts`, whose opening docblock names thinking level among the RPC surface deliberately left out -- that sentence changes with this card.

## Load-bearing

- Pi reports levels for the current model only, not per entry of `get_available_models`, so the offered list either comes after a model is set or is derived from the `reasoning` flag and `thinkingLevelMap` on `@earendil-works/pi-ai`'s `Model` type.
  The implementer picks, and the close note says which and why.
- Whether `set_model` resets the thinking level is unmeasured; the answer decides whether the adapter re-asserts the effort after a model change, so measure it.
- Pi's assistant turns carry no effort today: OW-61 made the footer's effort Codex-only on the claim "Pi's RPC protocol exposes no corresponding field", which the docs above refute.
  Stamp the chosen level onto Pi's assistant turns so the browser's footer and the Emacs meta line both show it, as they do for Codex's.
- What a resumed Pi session runs at: the session file carries `thinking_level_change`, but OW-pubulu found the resume spawn passes no `--model`, and `~/.pi/agent/settings.json` carries its own `thinkingLevel`.
  OW-pubulu's method settles it -- set a deliberately different default, resume, read `get_state` back.
  Whatever the answer, record it in OW-pubulu as well as in the adapter's docblock.

OW-pizaki (a model string with a thinking-level suffix answers 500 on `setModel`) is adjacent: with effort its own field, `setModel` need not accept the suffix.
Whatever this card decides about the suffix, record it in OW-pizaki.

## Done when

- A test in `src/server/adapters/pi/process.test.ts` asserts the chosen level reaches Pi as `set_thinking_level` before the first prompt, shown red first.
- A test asserts a Pi assistant turn carries the level the footer shows, shown red first.
- One live Pi turn on the home server, with the model pinned per `AGENTS.md` and a level other than the pin's `high`, has `get_state` read back and is recorded in `docs/MANUAL_TESTING.md` with the `pi` version.
- `bun run check` passes.

## Close note

Landed on main in five commits (bef251c..5381ae3). Pi now fills in the effort contract OW-kokalo defined, so the browser and Emacs pickers offer Pi effort and neither client changed.

What was built, in `src/server/adapters/pi/`:
- **Where the levels come from.** Each model's levels are derived from its catalogue entry by `thinkingLevels()` in `protocol.ts`. It is a transcription of pi-ai's `getSupportedThinkingLevels`, because D10 keeps pi-ai types-only. It uses the model's `reasoning` flag and its `thinkingLevelMap`.
  - The levels are not taken from `get_available_thinking_levels`, because that answers only for the current model, while `ModelInfo.efforts` is per model.
  - On the home server the derived lists matched Pi's own answer for the pinned model (`off, low, high, max`) and for `claude-fable-5`.
  - One deliberate departure: a model that does not reason offers `[]`, not Pi's `["off"]`.
  - `defaultEffort` is always null, because Pi picks its default from `settings.json`, which the catalogue does not carry.
- **Setting a level.** `setEffort` sends `set_thinking_level` immediately, not on the next prompt.
- **Tracking the level.** The effort in force is read from `get_state` (at start and after a fork) and from `thinking_level_changed` events.
- **Labelling turns.** Assistant turns are labelled with the level they started at, as `AssistantTurn.effort`, which the footer and meta line show.
- **Model changes.** The adapter re-sends a chosen level after `set_model` when the new model lists it, because Pi's `set_model` resets the level.

What was measured on the home server, 2026-09-23, `pi 0.87.1`. It is recorded in `docs/MANUAL_TESTING.md`, "A Pi turn at a chosen thinking level, what `set_model` does to it, and what a resume keeps (OW-ruzuhu)":
- **A live turn at `off`.** Pinned model, through agentpane's own server: the stdin tap shows `set_thinking_level off` sent before `prompt`, and the turn and status carry `effort: "off"`.
- **What `set_model` does.** It resets the level to the per-model settings default when there is one, and otherwise keeps it.
- **What a resume keeps.** It keeps the level the session file last recorded, over both settings defaults. But a `--model …:<level>` suffix overrides that level, which constrains OW-pubulu's fix; recorded there.
- **Unlisted levels.** Pi clamps a level the model lacks rather than refusing it.
- **The owner's settings were not touched.** Every run used `PI_CODING_AGENT_DIR` pointed at throwaway copies, and the owner's `settings.json` sha256 was unchanged.

The suffix on `setModel` is unchanged. Real catalogue ids contain colons, so stripping a suffix would break them; recorded in OW-pizaki.

How it was verified. Each test below was shown red by breaking the code it covers:
- `set_thinking_level` is sent before the first prompt.
- A turn carries the level the footer shows.
- `message_end` keeps the level the turn started at.
- The fork path adopts `get_state`'s level.
- The re-send waits for `set_model`'s answer.

`bun run check` passes, with 1212 tests.

An adversarial read found three further problems, now in other cards:
- **OW-helumu:** turns loaded by `get_messages` carry no level, so a fork or a resume blanks earlier turns' effort.
- **OW-zasozo:** a model change briefly broadcasts a status pairing the old model with the new model's level.
- **OW-tewofe:** `setEffort` is unchecked, so Pi silently clamps a bad value and accepts a level on a model that does not reason. OW-tewofe was amended to cover this.
