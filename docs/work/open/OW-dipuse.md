---
labels: [deferral, emacs]
---

# agentpane.el needs Emacs 31 and says so nowhere: no Package-Requires header, and Emacs 30 fails only when a header is first drawn

Found 2026-09-25 by the adversarial read of OW-tujula, from the Emacs NEWS files only; nothing was run on Emacs 30.
`emacs/agentpane.el` calls `string-pixel-width` with a BUFFER argument in `agentpane--fit-header`, and `with-work-buffer` in `agentpane--cut-by-motion`; the Emacs 31.1 NEWS lists both as new.
It also calls `sort` with `:key` in `agentpane--fit-window`, which Emacs 30 introduced.
The file's header carries no `Package-Requires`, and the Commentary names Emacs 31.1 only as the version its test runs were measured on.

## Done

The file states its floor where Emacs tooling reads it, a `;; Package-Requires: ((emacs "31.1"))` header line, so that `emacs --batch -l lisp-mnt --eval '(lm-with-file "emacs/agentpane.el" (print (lm-header "package-requires")))'`, run from the repository root, prints `"((emacs \"31.1\"))"` where today it prints `nil` (both checked 2026-09-25, Emacs 31.1, the first on a scratch copy carrying the line).
`package-buffer-info` is not the check: it also demands a `Version` header, which the file does not carry either, and whether to add one is the executor's call.
