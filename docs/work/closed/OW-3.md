---
labels: [deferral]
---

# `setWorkspace` fires per keystroke, so typing an absolute path can enumerate every prefix of it.

client workspace input

Decide between debouncing and committing on blur.

The seventh member in substance of the OW-26–OW-31 group from the first
hand-run of the built client on 2026-08-12, but it predates them: review had
already recorded the per-keystroke workspace input as a deferral.

**Fixed** in `26d104f` as part of OW-39: `setWorkspace` and the per-keystroke
server round-trip are gone entirely — the free-form input is replaced by a
workspace `<select>` derived from the already-listed sessions, and filtering is
now purely client-side over that in-memory list. No keystroke reaches the
server, so there is no prefix to enumerate.
