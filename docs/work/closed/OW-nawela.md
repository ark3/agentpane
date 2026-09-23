---
labels: [defect, emacs-native]
closed: done
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

## Close note

Fixed on the drawer side: `agentpane--insert-tool` in `emacs/agentpane.el` now draws a part whose `state` is `running` as `ok` unless `agentpane--streaming` is set and the node is `agentpane--tail-index`, applying the contract's rule again at draw time, as the pending-meta check in `agentpane--pp-node` already does.
Chosen over re-sending the last node from the helper because the drawer already holds both facts the rule needs and redraws the tail on the streaming flip (OW-fokisa), both are current on every draw path (a snapshot sets status before drawing, an upsert moves the tail before drawing, and `src/emacs/helper.ts` forwards every `isStreaming` change before any node projected under it), and it adds no protocol traffic.
The tail check goes one step past the card: a result-less call on a node that stops being the last while streaming continues also settles to `ok`, which is what the contract ("the call's node is the last one") and the browser say.
The tool `state` docblock in `src/emacs/protocol.ts` now says the state is as of the node's sending and that the drawer applies the rule again.
Verified by two new ert tests in `emacs/agentpane-test.el`, `agentpane-test-running-tool-settles-when-streaming-ends` (the card's done condition) and `agentpane-test-appended-node-settles-the-previous-running-tool`, both red against the unfixed `agentpane.el` and green after; the full ert suite (67) and `bun run check` pass.
