---
labels: [change]
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
