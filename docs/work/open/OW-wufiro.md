---
labels: [defect, emacs]
---

# A turn-done watch agentpane-mode keeps across a seq gap outlives the kill of its buffer, so a later buffer attaching the same live handle raises the indicator for a turn from elsewhere

Found 2026-09-30 by the adversarial read of OW-nuzoto, and confirmed there by a throwaway ERT probe; not reproduced against a real backend.

## The state

Since OW-nuzoto, a `session/detached` with `:cause "gapped"` keeps a `streamed` turn-done watch in `agentpane--turn-watches` (`emacs/agentpane.el`), so that a re-attach under the same handle raises the indicator when the turn ends, as the browser's `watchSessions` in `src/client/favicon.ts` does.
`agentpane--let-go` then sets `agentpane--handle` to nil, so from the gap on no buffer holds that watch's handle, and the watch has no owner.
`agentpane--detach`, the transcript's `kill-buffer-hook`, ends the watch only under the handle the buffer holds — `(agentpane--watch-forget agentpane--handle)` — which after a gap is nil, so a kill forgets nothing.
Its docstring states the hazard this reopens: "a buffer attached to the session later takes the same handle while the server holds it, where a watch left standing raised the indicator for a turn from elsewhere".

## The scenario

Buffer A submits T1 and sees it stream, a `seq` gap detaches A, and the user kills A: `("h1" . streamed)` is still in `agentpane--turn-watches`.
T1 ends unheard, the browser starts T2 under the same live handle, and the user opens buffer B on the session from the picker and attaches it while T2 streams, then switches away.
T2 ends and the indicator is raised for B, for a turn this Emacs never submitted.
It needs a gap, a kill, another client and a re-attach, so it is rare, and it costs one spurious indicator.

A kept watch also cannot tell its own turn from a later one without any kill: gap, T1 ends unheard, another client starts T2, A re-attaches mid-T2, and T2's end raises. That matches the browser, which keys its watch the same way, and is not this card; the `agentpane--watch-turn` docstring says so as of OW-nuzoto.

## The change

Give the watch a gap keeps an owner the kill can reach, rather than adding a second forget at the kill site.
Two shapes, the implementer's call: the buffer keeps the handle it let go of at a gap (for the kill and nothing else), or a watch records the buffer that armed it and a kill forgets every watch that buffer owns.
Whichever, the OW-nuzoto behaviour stays: a gap raises nothing, keeps a `streamed` watch, drops a `sent` one, and a re-attach from the same buffer under the same handle raises when the turn ends.

## Done when

- An ERT test in `emacs/agentpane-test.el`, red first: submit, see it stream, a `session/detached` with `:cause "gapped"`, `kill-buffer`, and no watch remains on the handle. Model it on `agentpane-test-turn-done-raised-after-a-gap-and-a-reattach`.
- Still green: `agentpane-test-turn-done-raised-after-a-gap-and-a-reattach`, `agentpane-test-turn-done-not-raised-by-a-gap`, `agentpane-test-turn-done-not-raised-after-a-gap-before-streaming` and `agentpane-test-turn-done-not-raised-by-a-shutdown` and `agentpane-test-shutdown-drops-a-watch-a-gap-kept`.
- The `agentpane--detach` and `agentpane--let-go` docstrings say who ends a watch kept at a gap.
- The ERT suite (`emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit`) and `bun run check` pass.
