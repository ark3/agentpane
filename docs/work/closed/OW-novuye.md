---
labels: [question, emacs, sweep-0929]
closed: done
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

## Close note

Decided with the owner on 2026-10-01: typed fields, option A of three. What the elisp needs of a tool call reaches it as typed fields on `ToolPart`, derived in `src/emacs/nodes.ts`, never parsed out of `args`, which is display text. The `src/emacs/protocol.ts` docblock records this as the contract's seventeenth raising, with the fields still pending.
OW-gakide adds `threadIds` through `subagentThreadIds`, absent where a call names none.
OW-4 adds `files` (path, kind, diff lines per file, from the Codex `changes[]`) and retires the flat `diff` in the same change. Keeping both was declined, because two fields would say overlapping things. OW-4 now carries the label `emacs` and its own done-condition.
Declined: having the elisp parse `args`. That would duplicate `subagentThreadIds` and the per-file grouping in Lisp and turn a display string into a contract.
Found while checking OW-4: `edits` from `fileChangeArguments` already merges every file's hunks into one list with no paths, so per-file data must come from `changes[]`. An `add`'s raw content yields no hunk at all, which is why `multi-patch.jsonl`'s second file drops out of the drawn diff.
OW-guyunu's per-child replies, if they ever reach the node, follow the same rule.
