---
labels: [change, emacs-native]
closed: done
---

# agentpane-mode names a transcript buffer after its first prompt, up to 80 characters; name it for its project and backend, as Magit does

Owner, 2026-09-23: the buffer names are too long, and the mode line is where that bites.
The preview in them is the session's first prompt, not a summary, and says little in its first characters — "Please execute the cards…".

## Today

`agentpane--buffer-name` in `emacs/agentpane.el` builds `*agentpane <backend>: <preview, cut at 60>*`, falling back to the session id where there is no preview.
`agentpane--composer-name` nests the whole transcript name inside `*agentpane composer: …*`, past 100 characters.
`agentpane--rekey` renames both buffers whenever a session's ref changes, a behaviour OW-gunaza added for the composer.

## The change

Decided with the owner on 2026-09-23:
- A transcript buffer is named `*agentpane/<backend>: <project>*`, e.g. `*agentpane/claude: sandbox*`, where `<project>` is the last component of the session's `:cwd`, as `magit: sandbox` names a repository.
- Several sessions in one project are told apart by the `<2>`, `<3>` suffix Emacs gives on its own through `generate-new-buffer` and `rename-buffer`'s UNIQUE argument, placed after the closing star as for `*scratch*<2>`.
  `uniquify` does not apply to buffers that visit no file, and nothing more is wanted.
  Picking a particular session is the picker's job (`agentpane-sessions`), and the transcript's header line, `agentpane--transcript-header`, already shows backend, session id and cwd.
- A rekey leaves the name alone: the name no longer carries the ref or the preview, and a rename could reshuffle the `<N>` suffixes mid-session.
  Drop the rename from `agentpane--rekey`, for the composer too, and update the tests that assert it rather than deleting them, so they now assert the names are unchanged across a rekey.
- The composer's name is its transcript's with any trailing `<N>` moved inside the stars and ` prompt` added before the closing star: `*agentpane/claude: sandbox*` has `*agentpane/claude: sandbox prompt*`, and `*agentpane/claude: sandbox*<2>` has `*agentpane/claude: sandbox<2> prompt*`.
  Transcript names are unique, so these are too, and a composer never takes a `<N>` of its own that could disagree with its transcript's; with no rename on rekey, the name holds for the composer's life.
- Two projects with the same directory name share a base name and are told apart by the suffix, as Magit's are.
- Where `:cwd` is absent or empty, `<project>` falls back to the session id, as the preview did; OW-ruhotu leaves the buffer's directory alone in that same case.

This card and OW-ruhotu both read the session's `:cwd` and do not depend on each other.

## Done when

`ert` tests in `emacs/agentpane-test.el`, run as that file's Commentary says, each red before the change:
- a transcript for a summary with `:cwd` `/tmp/x/sandbox` and backend `claude` is named `*agentpane/claude: sandbox*`;
- a second session in the same project gets the same name with Emacs's `<2>`;
- a rekey leaves the transcript's and its composer's names as they were (the existing test near `(format "*agentpane composer: %s*" (buffer-name))` is the one to rework);
- the composer of a transcript named `*agentpane/claude: sandbox*<2>` is named `*agentpane/claude: sandbox<2> prompt*`.
The whole file green, with the pass count in `emacs/agentpane.el`'s Commentary updated.

## Close note

Landed in bf36dde (implementer's two commits squashed).
A transcript buffer is now `*agentpane/<backend>: <project>*`, `<project>` being the last component of the session's `:cwd` (trailing slash tolerated) or the session id where there is none; sessions in one project take Emacs's own `<N>` after the closing star.
The composer is the transcript's name with that `<N>` moved inside the stars and ` prompt` added: `*agentpane/claude: sandbox<2> prompt*`.
`agentpane--rekey` no longer renames either buffer; review found that this left a composer `agentpane--absorb` adopts as the survivor's own carrying the killed buffer's name, so absorb now renames that one composer after the survivor.
Verified by `ert` in `emacs/agentpane-test.el`: three new naming tests, the two rekey tests reworked to assert names unchanged, and a merge test for the adopted composer, each shown red against the old code first; the whole file 74/74 on Emacs 31.1.
The one edge left, a composer outliving its killed transcript so a later composer takes a `<N>` of its own, is OW-futuve.
