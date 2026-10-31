---
labels: [deferral]
closed: declined
---

# The session walkers skip symlinked files and directories silently

`src/server/sessions/walk.ts` and `src/server/sessions/claude.ts` branch on `entry.isDirectory()` and `entry.isFile()` from `readdir` with `withFileTypes`.
Both are false for a symlink, so a store whose `sessions/` subtree or individual files are links lists nothing from them, with no diagnostic.
Nobody is known to do this; it is the kind of relocation a person makes once and then cannot explain why half their sessions vanished.

The fix, if wanted, is `stat` on `isSymbolicLink()` entries and the same containment check the Pi id needs (OW-fumegi) so a link cannot point the walk outside its root.

## Done when

A test under `src/server/sessions/` creates a temporary store with a symlinked session file and asserts it is listed; it fails before the change.
Or this card closes `--declined` with the reason.

## Close note

Declined by the owner on 2026-10-31 in the card triage: nobody is known to symlink a session store or its files.
Reopen if sessions are found missing behind a link; the fix is a stat of isSymbolicLink() entries plus the containment check OW-fumegi gave the Pi id.
