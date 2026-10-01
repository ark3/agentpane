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
OW-novuye decided on 2026-10-01 that the elisp never parses `args`, which is display text, and recorded that in the `src/emacs/protocol.ts` docblock.
This card adds `threadIds` to `ToolPart` there, derived in `src/emacs/nodes.ts` through `subagentThreadIds` and absent where the call names none, as on a spawn's `item/started`; it states that presence rule in the docblock's Parts section and replaces the docblock's sentence naming `threadIds` as pending with one saying it landed.

Scope is live transcripts only.
Since OW-luvema, `docs/DESIGN.md` D19 has the stored preview draw the same subagent card "with the child's id but no link to open it", and previews are projected by the same `projectTranscript`, so a preview's node will carry `threadIds` too.
Whether the preview offers the link is OW-kelise's decision; until it is made, the command does nothing in a preview buffer, as the browser draws no control there.

The browser's behaviour is pinned by `src/client/App.test.ts` "opens the child thread a subagent card names (OW-benige)" and by `src/client/render/tools/subagent.test.ts` "opens the child thread as its own session".

Done when an ERT test in `emacs/agentpane-test.el` runs the command on a subagent tool node and sees `sessions/preview` requested for the child's Codex ref, red before the change and green after, and a test in `src/emacs/` sees `threadIds` on the node for a subagent call.
