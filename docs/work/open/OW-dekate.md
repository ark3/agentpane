---
labels: [unverified, emacs]
blocked-by: [OW-mutufa]
---

# A one-transcript spike draws OW-mutufa nodes into an ewoc buffer so the owner can judge native rendering against agent-shell and the browser before D21

Filed 2026-09-21 from the owner's discussion of OW-vibipo.
This is that question's evidence step, and it exists because the decision now turns on one thing nobody has looked at.

## Why rendering is the whole question

The owner ran `agent-shell` bare on the home server for some days, without the shim, and reported two things on 2026-09-21.
What they missed was agentpane's fast session list and its fork, which are exactly what OW-basoga and OW-limejo would add; so the bare run is a fair trial of what the shim route would feel like, with those two features restored.
What they disliked was the rendering, which after significant tuning "now looks okay", and the shim cannot change that: OW-basoga's whole case was that no Emacs rendering is written, and once rendering work is being done anyway, that case is gone.
Everything else the owner named liking is a property of Emacs rather than of `agent-shell`: staying in one editor, jumping to Magit and back, editing long messages in place, `RET` for newline and `C-RET` to submit, and a choice between typing at the bottom of the transcript and a separate composer buffer.
A native mode gets all of those for a keymap and two commands (OW-gunuke carries the prompt modes).
So the streams differ on rendering alone, and the claim this card tests is that an `ewoc` buffer drawing OW-mutufa's nodes with `markdown-mode` faces, folded tool results and `diff-mode` faces looks closer to the browser transcript than the tuned `agent-shell` does.
That is a hypothesis, and D14's own history in `docs/DESIGN.md` says a UI decision comes from a rough cut looked at, not from argument.

## What to build

Two small pieces, neither of which is throwaway if the answer is yes.

A script `src/emacs/dump-nodes.ts`, run as `bun run src/emacs/dump-nodes.ts <backend>/<id> > /tmp/nodes.json`, that fetches `GET /api/sessions/:backend/:id/preview` from the running server (`ROUTES` in `src/shared/protocol.ts`, `createAgentpaneApi` in `src/client/api.ts` with its injectable `fetch`), runs OW-mutufa's projection over the response, and writes the node list as JSON.
Use a live preview rather than a fixture: the owner's own stored sessions carry real Edit calls, real diffs and real thinking blocks, and the projection's contract is the same either way.
This script is the seed of OW-refibu's `sessions/preview` and costs nothing extra.

A file `emacs/agentpane-spike.el` with one command, `agentpane-spike-render FILE`, that reads that JSON with `json-parse-buffer`, creates an `ewoc` in a fresh read-only buffer, and draws each node with a pretty-printer that follows OW-wavone's "Drawing" list: role line, text parts as markdown source fontified by `markdown-mode`'s keywords, tool parts as a summary line with arguments and result folded under the `invisible` property and toggled by `TAB`, diff lines in `diff-mode` faces, thinking folded behind its first line, the meta line in a dim face.
`n` and `p` move between nodes.
No helper process, no session list, no attach, no streaming.
Nothing else from OW-wavone, and in particular no `jsonrpc.el`; if the verdict is yes, this pretty-printer moves into `emacs/agentpane.el` under OW-wavone and the spike file is deleted in that card.
`markdown-mode` is installed on the home server under `~/.emacs.d/straight/repos/markdown-mode/` and `ewoc` ships with Emacs 30.2; nothing else is needed.

Pick two sessions to dump: one Codex session with an Edit call and one Claude session with thinking, so both the diff path and the folded-thinking path are on screen.

## Done when

The owner has opened the rendered buffer for both sessions beside the same transcripts in `agent-shell` and in the browser, and their verdict is recorded in OW-vibipo under a dated heading, with a sentence naming what the ewoc rendering got right and what it got wrong.
Whatever the verdict, OW-vibipo's own done condition then applies: D21 is written and the other stream's cards close `--declined` citing it.
If the verdict is that the rendering is worse and not fixable cheaply, this card closes `--done` all the same, since the evidence is what it promised, and the native-stream cards are the ones that close `--declined`.
No test suite gates this card: the spike's elisp is judged by eye, and its TypeScript half is a script rather than a module, so `bun run check` need only still pass with it present.
