---
labels: [defect, emacs, emacs-native]
---

# agentpane-mode sends a second sessions/attach when set-model, compact or a send starts while another attach is in flight, and one attach failing clears the in-flight flag for all

Filed 2026-09-22 from the implementer's report and the adversarial read of OW-yoyiya; each item reasoned from `emacs/agentpane.el`, none probed live.
In service of a transcript buffer having at most one attach in flight, so that the guards OW-yoyiya added mean what their docstrings say.

OW-yoyiya added two buffer-local flags in `emacs/agentpane.el`: `agentpane--sending`, which refuses a second prompt while one is out, and `agentpane--attaching`, which makes `agentpane-refetch` send nothing while an attach is out.
Neither makes `agentpane--attached-then` coalesce attaches, and that is what is left:

- **A second attach.** `agentpane-set-model` and `agentpane-compact` go through `agentpane--attached-then`, which checks only `agentpane--attached-p`, so either one run while a first-prompt attach is in flight sends another `sessions/attach`.
- **One flag, several attaches.** `agentpane--attaching` is a single boolean that each attach's reply or FAILED hook clears.
  If two attaches are out and the first fails, the flag clears while the second is still pending, and a `g` in that window sends `sessions/preview`, which can draw the stored transcript over the live one — the hazard OW-yoyiya closed.
- **The Pi fork's parent redraw.** The Pi branch of `agentpane--fork-at` clears `agentpane--attached` and calls `agentpane-refetch` to redraw the parent from the store (see `agentpane-fork`'s docstring, and OW-zovaye for why it exists).
  If the parent has an attach in flight at that moment, that refetch now sends nothing; if the server handled that attach before the fork but its reply lands after, the parent keeps the fork's shortened transcript and marks itself attached again, until the next attach.
- **A silent `g`.** `g` while attaching does nothing and says nothing, and is not replayed if the attach fails.
  Decide whether that deserves a message.

Load-bearing: whatever replaces the flag must still be cleared on every failure and timeout, including `agentpane--request` signalling synchronously, or it wedges the buffer; OW-yoyiya's tests in `emacs/agentpane-test.el` (`agentpane-test-one-send-at-a-time` and its neighbours) are the prior art for driving held replies through the `agentpane-test--forking` stub.

## Done when

An ert test in `emacs/agentpane-test.el` runs `agentpane-set-model` (or `agentpane-compact`) while a send's attach is held and asserts exactly one `sessions/attach` goes out, red before the fix.
A second holds two attaches, fails the first, and asserts a refetch still sends no `sessions/preview`, red before the fix.
The Pi fork case either gets a test, or a sentence in `agentpane-fork`'s docstring saying why it cannot arise once attaches coalesce.
