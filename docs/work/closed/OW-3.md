---
kind: deferral
where: 'client workspace input'
---

# `setWorkspace` fires per keystroke, so typing an absolute path can enumerate every prefix of it.

Decide between debouncing and committing on blur.

**Fixed** in `26d104f` as part of OW-39: `setWorkspace` and the per-keystroke
server round-trip are gone entirely — the free-form input is replaced by a
workspace `<select>` derived from the already-listed sessions, and filtering is
now purely client-side over that in-memory list. No keystroke reaches the
server, so there is no prefix to enumerate.
