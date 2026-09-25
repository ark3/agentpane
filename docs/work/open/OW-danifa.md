---
labels: [change, d24, emacs, emacs-native]
blocked-by: [OW-suyinu]
---

# agentpane-mode keys a transcript buffer by its handle, so a rename re-keys nothing and two buffers can never hold one session

Filed 2026-09-24 under D24 in `docs/DESIGN.md`; blocked by OW-suyinu, which puts `handle` on every helper notification and on the attach reply.
The Emacs half of what OW-kimaya does for the browser, per the parity rule in `AGENTS.md`.

## What happens today

`emacs/agentpane.el` keys a transcript buffer by its ref.
`agentpane--rekey`, whose docstring says "For a `session/renamed', and for an attach whose reply names another ref", moves a buffer onto a new ref, and `agentpane--absorb` merges two buffers that end up holding one ref (OW-jafini).
The helper synthesizes `session/renamed` in `sessions/attach` for the orderings OW-nuwive found, and `agentpane--fork-at`'s Pi branch marks the parent buffer detached because a Pi fork moves the live container with no `renamed` (OW-fojike, OW-zovaye).
Buffer names carry no ref since OW-mikayi, so a rename renames no buffer, which already fits.
Nodes are drawn by `index`, never by position (`src/emacs/protocol.ts`), which this card does not touch.

## What this card does

A buffer holds the handle its attach reply carried, every notification is routed to a buffer by `handle`, and the buffer's ref is an attribute updated from the notification's `session`.
`agentpane--rekey`'s rename half goes; `agentpane--absorb` goes, since two buffers cannot hold one handle; `session/renamed` is ignored until OW-mofuho removes it.
The Pi fork's parent buffer is still marked detached, now because the fork's reply names a new handle and the parent's handle stops receiving notifications.

Load-bearing: the one-attach-at-a-time and one-send-at-a-time flags (OW-yoyiya, OW-yibimi) are per buffer and stay, and a preview buffer, which has no handle, keeps working by ref.

## Done when

- The five ert tests named `agentpane-test-renamed-*` in `emacs/agentpane-test.el`, from `agentpane-test-renamed-rekeys-the-buffer` on, are replaced by tests that a `session/snapshot` under a held handle carrying a new `session` updates the buffer's ref and that no second buffer is ever created for a handle, red first against the ref-keyed mode.
- `agentpane-test-pi-fork-detaches-the-parent` and `agentpane-test-pi-fork-leaves-the-parent-as-it-was` stay green.
- ert green on the Emacs the recent Emacs cards ran on, Emacs 31.1, and `bun run check` green if `src/emacs/` is touched.
