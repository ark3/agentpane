---
labels: [deferral, emacs]
---

# A customised shr-bullet that opens with whitespace, or uses a character outside agentpane's marker set, draws Emacs list rows with no hanging indent

Found 2026-09-25 by the adversarial read of OW-bisima's fix.
`agentpane--insert-html` in `emacs/agentpane.el` now recognises a list row by the `shr-continuation-indentation` that `shr-tag-li` and `agentpane--shr-li` leave on the marker's first character, through an `adaptive-fill-function` that matches `"[ \t]*\\([0-9]+\\.?\\|[-–*•‣⁃◦]\\)[ \t]+"` and checks the property at group 1.
Two user settings of `shr-bullet` defeat that, as of Emacs 31.1:

- A bullet opening with whitespace, such as `" * "`: shr puts the property on the whitespace, the `[ \t]*` skips past it, group 1 carries no property, and the row hangs to its leading whitespace only.
  Before OW-bisima it hung past the marker, so this one is a regression, though agentpane never sets `shr-bullet` and the owner's config did not either as of 2026-09-25.
- A bullet outside the enumerated characters, such as `"→ "`: no hang, before OW-bisima or after it.

Deferred because neither setting is in use.
The route the reader proposed is to drop the character set entirely: find the character carrying `shr-continuation-indentation` on the line and return the marker as that many characters as its `shr-prefix-length` says, which `agentpane--shr-li` also sets.
shr sets `shr-prefix-length` on blockquote indents too, so check which characters actually carry it before relying on it.

In service of: text in the Emacs client wrapping as the browser's does, whatever the user's shr settings.

## Done

An ert test in `emacs/agentpane-test.el` that draws a bulleted list with `shr-bullet` let-bound to `" * "` and to `"→ "` and expects each row's `wrap-prefix` aligned past the whole marker is red against the code as OW-bisima left it, and green after, with `agentpane-test-text-part-hanging-indents` unchanged.
