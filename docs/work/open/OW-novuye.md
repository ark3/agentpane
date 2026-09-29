---
labels: [question, emacs, sweep-0929]
---

# Decide whether the Emacs node contract's ToolPart carries structured per-tool fields, which both OW-gakide's child-thread link and OW-4's per-file diff need and neither can build on args alone

Filed 2026-09-29 by a sweep of the open deck for consolidations (read against e1cf2e6, nothing run).

`ToolPart` in `src/emacs/protocol.ts` carries `name`, `summary`, `args` as a string, `result`, `state`, and an optional flat `diff` of `NodeDiffLine`s.
The file's docblock declares it a FROZEN INTERFACE in the sense of D11, to be raised before changing, and lists the six times it has been raised.

Two open cards reach the same fork in that contract:
- OW-gakide needs the child thread ids a live subagent call names, to open the child thread as the browser's Open thread does (OW-benige, D19); the browser reads them through `subagentThreadIds` in `src/client/render/tools/summary.ts`.
- OW-4's multi-file edit flattens its hunks under the first path, and in Emacs that happens in `diffFor` in `src/emacs/nodes.ts`, which flattens `editHunks` with no per-file path — so OW-4 is a both-client defect, not the browser-only one its body reads as.
Either `ToolPart` grows structured per-tool fields (say `threadIds`, and a per-file `{path, kind, diff}` list), or the elisp re-parses `args`, duplicating in Lisp what `src/client/render/tools/` already derives.
OW-guyunu's per-child replies would ride the same field if it ever gets a capture (OW-zadupu).

## Done when

The choice is recorded where the next reader of the contract will look: in `src/emacs/protocol.ts`'s docblock as its seventh raising if the fields are added, or in D11 in `docs/DESIGN.md` if the elisp is to parse `args`.
Whatever the answer, OW-gakide and OW-4 are amended to say what it means for them, and OW-4 is given its Emacs half explicitly.
