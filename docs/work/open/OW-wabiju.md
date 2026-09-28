---
labels: [deferral, emacs]
blocked-by: [OW-yibijo]
---

# Two edges of agentpane--dropped: a Pi fork's parent keeps it set, and a session/detached that lands before a deferred attach reply reaches no buffer

Found 2026-09-25 by the adversarial read of OW-yibijo, both reasoned from the code, neither reproduced.
OW-yibijo added `session/detached` (`dropDead` in `src/emacs/helper.ts`) and the buffer-local `agentpane--dropped` in `emacs/agentpane.el`, which makes `agentpane-refetch` attach instead of preview in a buffer the helper told its handle is gone; `agentpane--attached-as` is the only place that clears it.
Both edges were judged not worth holding OW-yibijo for.

## The fork parent

`agentpane--fork-at` sets `agentpane--attached nil` on the Pi fork's parent, whose container the server has let go (see the `agentpane--handle` docstring, "the parent of a Pi fork"), and leaves `agentpane--dropped` alone.
If a `session/detached` for the parent's handle lands while that fork is in flight, the flag stays set after the fork lands, and a `g` in the parent then attaches, spawning a backend, where an ordinary fork parent previews.
Whatever the fix, an ert test in `emacs/agentpane-test.el` drives the order, detached during the fork, and asserts that `g` on the parent sends `sessions/preview`, red first.

## A detached ahead of the attach reply

jsonrpc.el parks an asynchronous reply that arrives during a synchronous request as an "anxious continuation" and runs it afterwards, while notifications are handled at once (`docs/MANUAL_TESTING.md`, "jsonrpc.el runs an async reply after later notifications"; the same behaviour motivated `askedFor`, OW-mofuho).
If the helper has taken handle H from an attach reply Emacs has parked, and H dies and the stream reopens before the synchronous request ends, then the `session/detached` for H reaches no buffer: `agentpane--notified-buffer` routes it only to a buffer holding H, and its docstring says "no buffer holding the ref alone ever held it", which this window contradicts.
The parked reply then gives the buffer the dead H, and it counts itself attached to it.
That needs a synchronous request lasting across a server restart or a close elsewhere, so it is narrow.
Decide whether it is worth closing, and record the decision in the `agentpane--notified-buffer` docstring whichever way it goes: either fix it, with an ert test that parks the reply, delivers the detached first, and asserts the buffer ends up not attached, red first; or drop the docstring's claim.

## Amended 2026-09-28 under D25

Under D25 the helper no longer reopens its stream (OW-mepufi), so the second edge's route through "the stream reopens before the synchronous request ends" goes away; its other trigger, a `session/detached` from a close elsewhere reported by the listing at a `sessions-changed`, still stands.
The first edge, a Pi fork's parent, is unaffected.
