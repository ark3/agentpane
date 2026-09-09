---
labels: [deferral]
---

# `setModel` changes outgoing turns, but the reducer's identity may still report the previous model.

Codex adapter

OW-derewo reports the picker model from the adapter-owned value after a successful `setModel`, so reducer identity lag until the next turn cannot make the picker stale.
