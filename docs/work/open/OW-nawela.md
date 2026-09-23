---
labels: [defect, emacs-native]
---

# agentpane-mode keeps drawing a tool call as running after its turn ends without a result

Noticed 2026-09-23 while landing OW-fokisa, not reproduced live.

The node contract in `src/emacs/protocol.ts` (the `tool` part in the "Parts" list) says `state` is `"running"` only while the session is streaming, the call's node is the last one, and no result has arrived, and `"ok"` for "a call whose result never arrived in a finished turn".
The projection computes that in `toolPart` in `src/emacs/nodes.ts` at the moment it builds the node, through `toolState` in `src/client/render/types.ts`.
When streaming ends, the helper sends a `session/status` but no fresh node, so the Emacs buffer still holds the node built while streaming, with `state: "running"`.
OW-fokisa made `agentpane--set-status` in `emacs/agentpane.el` redraw the last node when streaming stops, but that redraw uses the node data the buffer already holds, so the `… running` marker stays.
The browser recomputes `toolState` on every render and does not show this.

The fix could go either way: the helper could re-send the last node on the streaming flip, or the drawer could treat `running` as `ok` once `agentpane--streaming` is nil.
Say in the close note which one was chosen and why.

## Done when

An `ert` test in `emacs/agentpane-test.el` draws a streaming last node holding a tool part in state `running`, sends a status with `isStreaming` false, and asserts the tool's header no longer shows the running marker.
It is shown red before the change.
Alternatively, if the fix is on the helper side, a test in `src/emacs/` shows the re-sent node, red first.
