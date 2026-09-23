---
labels: [deferral, emacs]
---

# Where agentpane-mode lags the browser has never been surveyed, so the parity rule covers new work only

On 2026-09-23 the owner made the Emacs client first-class, at feature parity with the browser, and `AGENTS.md`, "Both clients", now makes every new user-facing capability land in both.
Nothing yet says where the two already differ.
The open `emacs` cards (`card list --open --label emacs`) are rendering details found in use, not a gap list, and a capability the browser has and `agentpane-mode` lacks was never filed as a gap, because until that day it was not one.
The owner deferred the survey the same day so it would not pull attention off the effort work (OW-kokalo).

The survey compares what a user can do and see in `src/client/` -- `App.svelte`, `controller.ts`, and the renderers under `src/client/render/` -- against `emacs/agentpane.el` and the helper's methods in `src/emacs/protocol.ts`.
It counts capabilities, not pixels: a thing one client lets a user do or see that the other does not.
Differences D22 or a card already settled on purpose, such as the browser-only pointer rule D14 is scoped to, are listed with where they were settled, not filed as gaps.

Done when every gap found is an open card -- labelled `emacs` when the Emacs client is the one behind -- and this card's close note lists them, with any difference kept on purpose beside the decision that keeps it.
