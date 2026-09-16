---
labels: [change, emacs]
blocked-by: [OW-refibu]
---

# A native agentpane-mode in Emacs lists sessions in a tabulated buffer and shows any one as a read-only transcript, spawning nothing

Filed 2026-09-15, the native-mode stream (OW-mutufa, OW-refibu).
This is the first slice of the Emacs side, and it is the read-only half: the picker and the transcript buffer, with no attach and no composer.
It is also the tool OW-mikuyo deferred, built as the front door rather than as a separate reading mode, since here the transcript buffer is the same one a live session will later stream into.

## Files

One file, `emacs/agentpane.el`, with the helper started through `jsonrpc-process-connection` from Emacs's bundled `jsonrpc.el` on the command `bun run src/emacs/main.ts` resolved against a customizable project directory.
No package dependencies beyond what Emacs 30 ships plus `markdown-mode`, which is installed on the home server at `~/.emacs.d/straight/repos/markdown-mode/`.
The home server runs Emacs 30.2; keep `lexical-binding` on and prefer the built-in libraries named here over anything from `straight`.

## Picker

`agentpane-sessions`: a `tabulated-list-mode` buffer over `sessions/list`, one row per `SessionSummary` showing backend, status, streaming mark, updated time and `preview`, refetched on a `sessions/changed` notification.
`RET` on a row opens its transcript buffer through `sessions/preview`.
A `cwd` filter defaults to the project of the buffer the command was called from, with a prefix argument lifting it, matching the `?cwd=` query the browser sends.

## Transcript buffer

One buffer per session ref, named after the backend and the summary's preview, in a derived major mode `agentpane-transcript-mode` that is read-only.
The body is an `ewoc` whose nodes are the projection's nodes from OW-mutufa and whose pretty-printer draws one node: a role line, then each part.
`ewoc` was chosen 2026-09-15 because its model is D3's model, a list of nodes redrawn one at a time by `ewoc-invalidate`, and the live slice depends on exactly that; `magit-section` was the alternative, and its whole-buffer redraw is what ruled it out.

Drawing:

- A text part is inserted as its markdown source and fontified by `markdown-mode`'s font-lock keywords; a first cut may call `markdown-mode`'s fontification on the region, and native code-block fontification is the `markdown-fontify-code-blocks-natively` customization, off by default.
- A tool part draws the summary line, then the arguments and result text folded under it, hidden with the `invisible` text property and toggled by `TAB` on the summary line; a diff draws its lines with `diff-mode`'s faces.
- A thinking part draws folded, with its first line as the summary.
- The meta line draws in a dim face, and an aborted or errored turn in a warning face.
- An image part draws a placeholder naming its mime type; inline images are a later card if wanted.

Navigation: `n` and `p` move between nodes through `ewoc-goto-next` and `ewoc-goto-prev`, `TAB` folds at point, `g` refetches the preview, `q` buries.
Each node's `index` is stored on the ewoc node's data so a later command can read it at point.

## Docs

Nothing in `docs/DESIGN.md` yet; the decision that picks this stream is its own card.
D14 does not bind an Emacs client; OW-basoga already planned the sentence scoping D14 to the browser, and whichever stream lands writes it.

## Done when

`ert` tests in `emacs/agentpane-test.el`, run with `emacs --batch -L emacs -l ert -l agentpane -l agentpane-test -f ert-run-tests-batch-and-exit` from the repository root, cover the pure half with no helper process: rendering a fixed list of nodes into a buffer yields the role lines and summary lines in order, a tool part's result is invisible until toggled, and a diff part's added and removed lines carry the diff faces.
That command and its expected output are recorded in the file's commentary; it is not part of `bun run check`, which stays Bun-only.
On the home server: `agentpane-sessions` lists the stored sessions the browser lists, `RET` on a stored Codex session shows its transcript with no child process spawned (check `ps` or the server log), and the observation is recorded in `docs/MANUAL_TESTING.md` with the Emacs and agentpane versions.
