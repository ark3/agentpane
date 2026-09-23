---
labels: [change]
blocked-by: [OW-kokalo]
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
