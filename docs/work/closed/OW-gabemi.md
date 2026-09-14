---
labels: [change, work-laptop]
closed: done
---

# Set the work laptop up for card: install the tool, write that clone's deck config, and verify the deck serves there.

**Work laptop:** needs the machine itself — one visit, after the cutover
lands there.

the work laptop's agentpane clone — its `.git/card/` and PATH, nothing in this repo

Filed 2026-08-27 alongside OW-pisape and OW-kekavi, for the half of the
migration only that machine can do. Runs strictly after both have landed
*and been pulled* on the laptop; by then the skills are gone, so this item
is executed under card's own workflow — `card status` in the clone is the
procedure, not `.claude/skills/`.

The install and the config are the owner's, by hand: agents are sandboxed on
that machine as everywhere, and cloning card's repo into a home directory or
symlinking it onto PATH is outside any session's reach — the same reason the
cutover session here verified the clone URL without being able to exercise it.
The owner installs card (a checkout of its repo, `bun install`, `src/card.ts`
symlinked onto PATH) and writes the laptop clone's
`.git/card/card-config.toml`; `AGENTS.md`, "Cards", states the three lines
that file must hold, and is the single copy of that fact — if the machine
disagrees with it, fix `AGENTS.md` in the same change.

What a session on the laptop does is verify the result and close this card.

Done when, all on the laptop:

- `card status` in the laptop clone names that clone's deck directory,
  reports the same open and closed counts as the home server at the same
  commit, and serves the public rendering — no privacy rules, no
  id-citation ban.
- `card show OW-1` and `card show` on any drawn id both parse there.
- The close note names the tool versions that mattered (bun, and the card
  checkout's commit) and anything the visit had to fix, and the close itself
  goes through card's close procedure — this machine's first.

## Close note

Verified on the work laptop with bun 1.4.2 and card checkout 2321344a6279fc79e9b60c81b2bb13bab07bf07e: card status identified the public /home/asa0717/src/agentpane/docs/work deck at 64 open and 157 closed cards, and card show OW-1 plus card show OW-gabemi both parsed.
Updated AGENTS.md to state that the three deck settings are required while allowing the laptop's additional local [run] settings.
