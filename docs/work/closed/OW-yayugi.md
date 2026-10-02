---
labels: [deferral, emacs-native]
closed: moot
---

# src/emacs/dump-nodes.ts has no consumer since the spike it fed was absorbed into emacs/agentpane.el

Filed 2026-09-22 at the close of OW-wavone.

`src/emacs/dump-nodes.ts` was OW-dekate's feeder: it fetched a stored session's preview from the running server, projected it through `src/emacs/nodes.ts`, and wrote the node array as JSON for `emacs/agentpane-spike.el` to read from a file.
OW-wavone deleted the spike and reads nodes from the helper over JSON-RPC, so nothing in the tree consumes that JSON now; the script's docblock still says it is verified by running it against a real session, and no test covers it.

It still has one use: a JSON dump is the quickest way to look at what the projection emits for a given session without an Emacs, and it is the only runner of `src/emacs/render.ts` outside the helper.
Decide whether that earns its place.
Done when either the script is deleted along with the references to it in `docs/DESIGN.md` under D22 and in the OW-dekate and OW-vibipo history (those may stay as past tense), or its docblock says what it is now for and that the spike is gone.

## Close note

Moot, checked at b758f98 by OW-geselo: the premise that `src/emacs/dump-nodes.ts` has no consumer is false, and the docblock half of the done-condition already holds.
It is the instrument cited in `docs/MANUAL_TESTING.md` sections "The native Emacs mode drives a Codex session live (OW-gunuke)" and the OW-fojike fork section (`bun run src/emacs/dump-nodes.ts codex/<thread id>`), and in the open OW-yobuyi and the closed OW-zabiko, OW-buligi and OW-jakahe; D22 in `docs/DESIGN.md` names it too.
Deleting it would orphan those reproductions.
Its docblock, unchanged since OW-refibu, says what it is for ("Dump one stored session as Emacs nodes") and never mentions the deleted spike, so there is nothing stale in it to fix.
It is not the only runner of `src/emacs/render.ts` outside the helper, as the card said: `src/emacs/nodes.test.ts` loads the real renderer in "carries the browser's own HTML when given the real renderer"; it is the only non-test one.
