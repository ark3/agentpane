---
labels: [deferral, emacs-native]
---

# src/emacs/dump-nodes.ts has no consumer since the spike it fed was absorbed into emacs/agentpane.el

Filed 2026-09-22 at the close of OW-wavone.

`src/emacs/dump-nodes.ts` was OW-dekate's feeder: it fetched a stored session's preview from the running server, projected it through `src/emacs/nodes.ts`, and wrote the node array as JSON for `emacs/agentpane-spike.el` to read from a file.
OW-wavone deleted the spike and reads nodes from the helper over JSON-RPC, so nothing in the tree consumes that JSON now; the script's docblock still says it is verified by running it against a real session, and no test covers it.

It still has one use: a JSON dump is the quickest way to look at what the projection emits for a given session without an Emacs, and it is the only runner of `src/emacs/render.ts` outside the helper.
Decide whether that earns its place.
Done when either the script is deleted along with the references to it in `docs/DESIGN.md` under D22 and in the OW-dekate and OW-vibipo history (those may stay as past tense), or its docblock says what it is now for and that the spike is gone.
