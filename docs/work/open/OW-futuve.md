---
labels: [deferral, emacs]
---

# A composer outlives its killed transcript, so a later transcript's composer can take a <N> of its own

Found while landing OW-mikayi on 2026-09-23.

OW-mikayi names a composer after its transcript — `*agentpane/claude: sandbox*<2>` has the composer `*agentpane/claude: sandbox<2> prompt*`, built by `agentpane--composer-name` in `emacs/agentpane.el` — and argued that since transcript names are unique, composer names are too and never take a `<N>` of their own.
That holds only while each composer's transcript lives.
Killing a transcript buffer runs its buffer-local `kill-buffer-hook`, which is `agentpane--detach` alone (added where `agentpane-transcript-mode` sets up the buffer); nothing kills or renames its composer, which stays live with `agentpane--composer-transcript` pointing at a dead buffer.
A transcript opened later in the same project can take the freed name, and when `agentpane-prompt` then calls `generate-new-buffer` with its composer name, the leftover composer already holds it, so the new one comes up as `*agentpane/claude: sandbox prompt*<2>`, a name that no longer mirrors its transcript's.
The implementer kept `generate-new-buffer` over `get-buffer-create` deliberately, since the latter would hand the new transcript the dead one's composer.

Judged not worth blocking OW-mikayi on: it needs a kill, a reopen in the same project, and a composer left open across both.
The likely fix is deciding what a composer should do when its transcript dies — killed with it, or kept for its draft — and that decision, not the naming, is the work.

Done when an `ert` test in `emacs/agentpane-test.el` that kills a transcript with a composer open, opens a new transcript in the same project and opens its composer, goes red first and green after, asserting the new composer is named after its transcript with no `<N>` of its own; the whole file green, run as that file's Commentary says, with the pass count in `emacs/agentpane.el`'s Commentary updated.
