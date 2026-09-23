---
labels: [deferral, emacs-native]
---

# A live upsert that changes two nodes, a folded result becoming an orphan or the reverse, reaches Emacs as one, since projectUpsert returns one node

Split out of OW-fokisa on 2026-09-23, where it was the fifth item; the rest of that card is facts to add to the node contract, and this one is not a missing fact but a documented limit.

A live `upsert` can in principle change two nodes: a folded tool result becoming an orphan `tool-result` node, or an orphan folding away into its call when the call lands.
`projectUpsert` in `src/emacs/nodes.ts` returns one node, so the Emacs buffer would redraw one and leave the other stale until the next snapshot or `g`.
The adversarial read of OW-mutufa, 2026-09-21, found no server path that emits either sequence, which is why it stands as a limit and not a defect.

Worth doing if a server path is ever found to emit one: done then when a test in `src/emacs/nodes.test.ts` feeds that sequence and the buffer ends with both nodes as a fresh snapshot would draw them.
Until then it closes `--moot` if the projection changes shape so that the case cannot arise, or stays here as the record that it was considered.
