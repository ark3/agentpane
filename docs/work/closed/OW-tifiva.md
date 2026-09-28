---
labels: [defect, emacs]
closed: moot
---

# An attach reply that lands after the Emacs helper detached its gapped session leaves the buffer attached and hearing nothing

Filed 2026-09-28 from the adversarial read of OW-filuge, which made a `seq` gap detach that one session in the helper instead of attaching it again (D25 point 5 in `docs/DESIGN.md`; `detachGapped` in `src/emacs/helper.ts`).
The attach-on-gap code before OW-filuge had neither ordering below: its own attach brought a fresh snapshot whatever had happened in between.
Both orderings need a gap inside the few milliseconds between an attach's broadcast snapshot and its REST reply, and a gap on loopback needs a dropped or malformed frame, so both are narrow; `g` in the buffer recovers.

## The two orderings

Both were run by the reader against the OW-filuge helper and printed the helper's output frames.

1. Renamed ref. Emacs sends `sessions/attach` by ref A, and the server answers under ref B with handle H (an alias left by a rename, or a `virtual` id's first start). The attach's broadcast snapshot under B arrives first; `isAttached` does not forward it, since `pending` is keyed by A, but the reducer forms the view for H. An event under H then gaps: `detachGapped` deletes the view, and H is not in `attached`, so Emacs is told nothing. The reply then lands: the `sessions/attach` handler's `if (pending.delete(key))` branch sets `attached` and `askedFor` for H, finds `state.sessions[H]` absent, and sends no snapshot. Every later event under H is ignored for want of a view. The whole output was the reply alone. In Emacs, `agentpane--attached-as` takes H from the reply and the buffer counts itself attached.
2. Same ref. The attach's snapshot moves the pending attach into `attached` (`isAttached`) and goes out, the gap then drops it and sends `session/detached`, and the reply comes last: output `[session/snapshot, session/detached, reply]`. The helper does nothing at the reply, since `pending.delete(key)` is false, but Emacs handles the reply after the detached, in wire order and also when jsonrpc.el parks the reply as an "anxious continuation" (`docs/MANUAL_TESTING.md`, "jsonrpc.el runs an async reply after later notifications"). `agentpane--attached-as` then clears `agentpane--dropped` and re-binds H, so the buffer counts itself attached while the helper holds neither the attachment nor the view.

The `detachGapped` docblock's sentence "the snapshot that attach broadcasts forms the view again and goes out as its first notification" holds only when the gap lands before that snapshot; OW-filuge's landing narrowed it and cites this card.

## What is load-bearing

Whether Emacs is attached is decided in two places: the helper's `attached` map, and the buffer's `agentpane--attached-as` at the reply.
A gap that drops the helper's side while an attach reply for that handle is still in flight is undone by the reply on the Emacs side (ordering 2), or never reaches the Emacs side at all (ordering 1).
The fix has to reconcile an attach in flight with a gap; adding a re-check of the view at the reply site covers ordering 1 and not ordering 2.
One shape, a guess and not a decision: the helper fails that attach request with a JSON-RPC error once a gap has consumed the snapshot it would have delivered, so the buffer stays `agentpane--dropped` and `g` attaches again (the `agentpane--dropped` docstring: "It stays set when that attach fails").
`dropDead`'s rule, "Only a handle held when the listing was asked for can be dropped by its answer", is the prior art for the same race against a listing.
OW-wabiju, "A detached ahead of the attach reply", is the Emacs-side cousin for `dropDead`'s `session/detached`; read it before choosing, since one fix may serve both.
Nothing re-attaches on Emacs's behalf: D25 point 5 stands.

## Done when

Two tests in `src/emacs/helper.test.ts`, each red first, drive one ordering apiece with the fake event source and `fetch` the file's other tests use, and assert that Emacs does not end up believing it is attached to H while the helper sends nothing under it, in whatever form the fix takes: for instance, no successful reply binding H without a snapshot for H following it, or the reply an error.
Where the fix changes what Emacs sees, an ert test in `emacs/agentpane-test.el` asserts that the buffer ends `agentpane--dropped` after ordering 2's frames, in either delivery order.
The `detachGapped` docblock states what happens to an attach in flight.
`bun run check` passes.

## Close note

Moot under D25's "What the run found, and the two ownership changes it asked for" (2026-09-28): OW-rebawa makes the helper's notifications the only thing that binds a buffer, and the helper records an attachment only when it forwards its snapshot, so neither a late reply nor a reply with no view can leave a buffer believing it is attached; both of this card's orderings are OW-rebawa's red-first tests.
