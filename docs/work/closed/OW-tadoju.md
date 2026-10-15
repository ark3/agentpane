---
labels: [change]
closed: done
---

# No probe surveys the shape of a real Pi session store, so finding a new entry type or message field means reading the owner's files by hand

Filed 2026-10-14, when the `role: "system"` messages and per-message `thinkingLevel` behind OW-wavini and OW-zarine were both found by ad hoc `jq` over the home server's `~/.pi/agent/sessions`.

`src/server/sessions/pi.ts` and `storedAgentMessage` in `src/server/sessions/preview-message.ts` read Pi's files, and `src/server/sessions/real-dirs.smoke.test.ts` checks them against the real store only to the extent that the listing parses.
The home server's store is small, 13 files as of 2026-10-14; the work laptop's is where Pi is used daily, across many Pi versions and with extensions and MCP in use, and it is the store most likely to hold a shape agentpane has never seen.

In service of finding on-disk drift by running one command rather than by noticing it, and of making the work-laptop survey a single command the visit runs.

## What is load-bearing

It prints structure and never content: entry `type`s, message `role`s, the set of keys each (entry type, role) carries, content block `type`s, the header's `version`, and counts of each, grouped by the month of the file's modification time, since a Pi file does not name the Pi version that wrote it.
No text, prompt, path, cwd, tool argument or tool output appears in its output, which is what lets it run over any store, including one whose contents are private; the probe's docblock says so and a test proves it on a synthetic file seeded with a distinctive string.
It also reports, as its own section, every (entry type, role) and key that `storedAgentMessage` and `parsePiSession` do not read, so the output is a list of what agentpane ignores rather than a census to interpret.
It takes the store root as an argument, defaulting to `~/.pi/agent/sessions`.
Python or Bun is the implementer's call; `resources/probes/` is where it lives and `resources/probes/README.md` documents it.

## Done when

The probe exists with its README entry, its no-content test passes, and `bun run check` passes if the test is a vitest one.
It has been run on the home server's store and its output, which is structure only, is recorded in `docs/MANUAL_TESTING.md` with the date and the installed `pi --version`.
Every shape in that output that agentpane mishandles and no open card already carries gets a card.

## Close note

Built `resources/probes/pi_store_survey.ts` (Bun, run as `bun resources/probes/pi_store_survey.ts [root]` from the repo root, no `bun install`), documented at the end of `resources/probes/README.md`.
It surveys every `*.jsonl` under the root whose line 1 is a Pi session header and prints a census by UTC month of file mtime (positions, keys with value kinds, block types, roles, header `version`, and `stopReason`/`thinkingLevel` only when members of the 1.2.0 unions), then a "Not read by agentpane" section.
Message- and block-level classification is measured, not hand-kept: each message goes through the checkout's real `storedAgentMessage` behind a Proxy that tells a named read from a spread's copy (descriptor read first), sorting keys into named, carried-unnamed-by-spread, and dropped; entry-level reads are the hand-kept `ENTRY_READS`, which no test holds, so OW-yilene was amended to update it.
No-content guarantee: no value, path, name or filesystem error message is printed; identifier-shaped keys and discriminators at schema positions print on the trust that code chose them, and the docblock and README say an extension spreading a data-keyed map would defeat that.
`src/server/sessions/pi-store-survey.test.ts` (runs in `bun run check`) seeds one marker in ~40 content positions plus a foreign `.jsonl`, unreadable directory and file, missing root and prototype-named types; the dispatching session watched it go red by letting the walk descend into tool `arguments`, and the adversarial reader red-tested eight more mutations.
That reader's review added skipping of unreadable and non-session files by error-code count, and the own-key lookup.
Run on the home server's 13 files on `pi 1.2.0` and recorded byte-identical in `docs/MANUAL_TESTING.md`, "The home server's Pi store, surveyed for what agentpane does not read (OW-tadoju)".
Shapes it found: `session_info` unread (OW-yilene), `parentSession` dropped (OW-vezipo), one in-file branch the preview draws in file order (filed OW-gogoka), `errorMessage` reaching both clients only through a spread (filed OW-kejele); `model_change`/`thinking_level_change` unread by the preview, leaving pre-stamp replies unlabelled, which OW-zarine's preview scope already chose.
OW-furivo was amended with the exact visit command and what the deck carries for each shape the home server's store did not hold.
