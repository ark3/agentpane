---
labels: [defect, emacs-native, now]
---

# agentpane-mode's meta line prints #index, raw token counts and a zero cost where the browser's footer prints none of them

Owner, 2026-09-23, on the work laptop against Claude Code: where the browser's footer reads `2026-09-23 11:16:59  claude-opus-5  136K tok`, the Emacs buffer reads `#251 · claude-opus-5 · 136013 tokens · $0.0000`.
No card chose the difference: `agentpane--insert-meta` in `emacs/agentpane.el` came over from the OW-dekate spike (`ee12116`) into OW-wavone unchanged, and neither card compared its fields with the browser's.

The reference is the `meta()` snippet in `src/client/render/Message.svelte`: model when present, `effort` when present, and only when `usage.totalTokens > 0` the token figure through `compact`, an `Intl.NumberFormat` with `notation: "compact"`, suffixed ` tok`, followed by the cost at four decimals only when `cost.total > 0`.
Match that content.
Specifically:
- Drop `#<index>`: no browser surface shows it, and `n`, `p` and `f` read the index from the node, not the line.
- Tokens in the browser's compact form, e.g. `136K tok`, and absent when zero.
- Cost absent when zero, which is every Claude Code turn.
- Keep `stopReason` and `errorMessage` and the warning face: the browser shows those as a banner beside the footer, and the line is where Emacs shows them.
The browser's `model ?` has no counterpart, since it simply omits a missing model; omit it too.
The separator and face are presentation and may stay.

The timestamp is not this card: a node does not carry one, and OW-fokisa lists it among the facts to add to the contract.
Nor is `showsMeta`'s suppression of the whole line for a pending turn, also on OW-fokisa's list.

## Done when

In `emacs/agentpane-test.el`, run as that file's Commentary says: `agentpane-test-lines-in-order`, which today searches for `— #1 · haiku · 12 tokens`, expects the new content, and a new test draws meta with 136013 tokens and zero cost and asserts the line contains `136K tok` and neither `#` nor `$`, and one with non-zero cost shows it at four decimals.
Both red before the change; the whole file green after, with the Commentary's pass count updated.
