---
labels: [change, emacs]
closed: done
---

# agentpane-mode offers no way to open the child thread a subagent tool call names, where the browser's Open thread does (OW-benige, D19)

Found by the OW-varevo parity survey on 2026-09-26; the parity rule is `AGENTS.md`, "Both clients".

On a live transcript, the browser's subagent card (`src/client/render/tools/SubagentTool.svelte`) lists the child threads the call names, which `subagentThreadIds` in `src/client/render/tools/summary.ts` reads from the call.
Its "Open thread" goes through `onopensession` to `openSession` and `controller.preview`, opening the child as a session of its own (closed OW-benige).
In `emacs/agentpane.el` the tool header shows each id's short form (its last 8 characters since OW-guyunu), since `toolSummary` in the same `summary.ts` appends them and `src/emacs/nodes.ts` carries that summary onto the node.
The full ids appear only inside the args JSON that `agentpane--tool-body` shows in the fold, and no command opens them.

Opening is `sessions/preview`, which exists.
The node carries no thread-id field: the ids sit only in the `args` string.
OW-novuye decided on 2026-10-01 that the elisp never parses `args`, which is display text, and recorded that in the `src/emacs/protocol.ts` docblock.
This card adds `threadIds` to `ToolPart` there, derived in `src/emacs/nodes.ts` through `subagentThreadIds` and absent where the call names none, as on a spawn's `item/started`; it states that presence rule in the docblock's Parts section and replaces the docblock's sentence naming `threadIds` as pending with one saying it landed.

The command works in a preview buffer as in a live one.
Since OW-luvema the stored preview draws the same subagent card, and previews are projected by the same `projectTranscript`, so a preview's node carries `threadIds` too; OW-kelise decided on 2026-10-01, beside D19 in `docs/DESIGN.md`, that the preview's card offers Open thread in both clients.

The browser's behaviour is pinned by `src/client/App.test.ts` "opens the child thread a subagent card names (OW-benige)" and by `src/client/render/tools/subagent.test.ts` "opens the child thread as its own session".

Done when an ERT test in `emacs/agentpane-test.el` runs the command on a subagent tool node and sees `sessions/preview` requested for the child's Codex ref, red before the change and green after, once from a live buffer and once from a preview buffer, and a test in `src/emacs/` sees `threadIds` on the node for a subagent call.

## Close note

Landed in 300a732 and 193f608.
`ToolPart` in `src/emacs/protocol.ts` gains `threadIds`, derived in `src/emacs/nodes.ts` through `subagentThreadIds` for a call named `subagent` (case-insensitive, as `resolveToolRenderer` picks `SubagentTool`) and absent where it names none; the docblock's Parts section states that rule and the OW-novuye paragraph now says OW-gakide added it.
`agentpane-open-thread`, bound to `o` in `agentpane-transcript-mode-map`, reads `threadIds` from the tool part at point (else every part of the node at point), asks with completion when there are several, and opens the child's Codex ref through `agentpane-show-transcript`, the picker's path, which sends `sessions/preview` and attaches nothing.
Evidence: `src/emacs/nodes.test.ts` "carries the child threads a subagent call names as threadIds..." and ERT `agentpane-test-open-thread-from-a-live-buffer` and `agentpane-test-open-thread-from-a-preview-buffer`, red before and green after; `bun run check` 1612 passed, ERT 241 run, 0 unexpected.
