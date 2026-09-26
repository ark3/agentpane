---
labels: [change, emacs]
---

# agentpane-mode offers no way to open the child thread a live subagent tool call names, where the browser's Open thread does (OW-benige, D19)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

On a live transcript, the browser's subagent card (`src/client/render/tools/SubagentTool.svelte`) lists the child threads the call names, which `subagentThreadIds` in `src/client/render/tools/summary.ts` reads from the call.
Its "Open thread" goes through `onopensession` to `openSession` and `controller.preview`, opening the child as a session of its own (closed OW-benige).
In `emacs/agentpane.el` the tool header shows each id's first 8 characters, since `toolSummary` in the same `summary.ts` appends them and `src/emacs/nodes.ts` carries that summary onto the node.
The full ids appear only inside the args JSON that `agentpane--tool-body` shows in the fold, and no command opens them.

Opening is `sessions/preview`, which exists.
The node carries no thread-id field: the ids sit only in the `args` string.
A structured field would change the node contract that `src/emacs/protocol.ts` declares a "FROZEN INTERFACE, in the sense of DESIGN D11", and that docblock says to raise such a change before making it.
Parsing `args` in elisp avoids that.
Which of the two this card takes is its own to decide, and the change states why.

Scope is live transcripts only.
`docs/DESIGN.md` D19 leaves the stored preview with "no child link at all" in both clients, and OW-kelise holds that gap.

The browser's behaviour is pinned by `src/client/App.test.ts` "opens the child thread a subagent card names (OW-benige)" and by `src/client/render/tools/subagent.test.ts` "opens the child thread as its own session".

Done when an ERT test in `emacs/agentpane-test.el` runs the command on a subagent tool node and sees `sessions/preview` requested for the child's Codex ref, red before the change and green after.
