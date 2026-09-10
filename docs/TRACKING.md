# Tracking

This is the historical decision record for agentpane's card storage and the migration that produced it.
It is not a procedure and no part of it is normative.
`AGENTS.md`, "Cards", is the repository-specific authority, and `card workflow`, `card author`, and `card execute` carry the current procedures.
OW-rizima replaced the original 993-line migration record with this synopsis; git history retains the executed conversion specification, dated measurements, and superseded commands.

## Why the storage changed

Open and closed work originally lived as rows in two Markdown tables.
The tables were internally consistent when measured before the migration, so correctness was not the reason to replace them.
The cost was the careful mechanical editing required to add or close work, the poor diffs and limited structure of long single-line rows, and conflicts between clones editing the same hot end of a shared table.
The work laptop authored new rows while the home server closed recent rows, so nominally separate roles repeatedly touched the same few lines after their clones had diverged.
That observed two-clone conflict, rather than the earlier hypothetical need for assignees or formal dependency fields, triggered the change.

Changing storage did not address stale claims about the code.
Reading the source again before executing a card remains the safeguard against staleness.

## Why cards are one file each

Each work item became one Markdown file under `docs/work/open/` or `docs/work/closed/`, with status represented by the containing directory.
Closing a card moves the file and appends its close note.

This shape was chosen for three reasons:

- Adding one card and closing another normally change disjoint paths, removing the shared table's hot zone without adding locks or claims.
- A card can use ordinary Markdown paragraphs, lists, headings, and code blocks, and line-level history remains useful as its prose changes.
- Status is structural: a file occupies one of the two directories instead of repeating open or closed state in an index or metadata field that can drift.

There is no committed index because it would duplicate status, drift when a card changed without regeneration, and recreate the one shared hot file this layout removed.
Close notes remain with closed cards because their evidence can ground later work.

The design borrows the useful part of Maildir's one-message-per-file layout without its filename flags, delivery protocol, or `new` and `cur` distinction.
Build-slice status remains a separate concept in the table at the top of `docs/WORKSTREAMS.md`.

The file shape was initially kept directly greppable: one unwrapped `# ` headline, flat one-line frontmatter, and explicit sorting whenever order mattered.
The `card` CLI now provides the ordinary list, filter, create, close, show, and worktree operations, while `card cmd` keeps raw deck queries available.
Each card's former `kind:` field became exactly one required kind label; optional execution labels may accompany it, and `AGENTS.md`, "Labels", owns the current definitions.

## Why identifiers have their present form

### The `OW-` prefix stays

The prefix began as "open work" but is now opaque: closed cards keep the same identifier.
By the time renaming was considered, `OW-` identifiers appeared throughout published commit subjects, documentation, tests, and code comments.
Renaming would permanently orphan historical references without making the storage or tooling more general.
The tooling accepts a project-configured prefix, so other projects can choose their own while this repository preserves `OW-`.

### New identifiers are random pronounceable strings

Sequential allocation failed once concurrent sessions and dispatched worktrees could each read a stale maximum.
Two branches choosing the same next number at least produce an add/add collision, but two sessions in one working tree can silently overwrite the same newly created path; that happened on 2026-08-18 and the items had to be recovered from commit `1e40fc4`.
There is no durable serialization point or stable partition that covers every clone, session, and on-demand worktree.

The owner therefore chose identifiers made from three random consonant-vowel syllables, such as `OW-keraha`.
A headline-derived slug was rejected because headlines are sharpened as understanding changes, while an identifier must remain stable and should not preserve an obsolete description.
The pronounceable form makes transcription errors easier to notice than an arbitrary character string; its suffix uses lowercase characters without digits and has 729,000 possible values.
`card new` draws the identifier and checks both open and closed directories before creating it.

Existing numeric identifiers were not renamed, so the deck permanently contains both forms.
No operation needs to distinguish them, and every existing citation remains true.

## What migrated and where current tooling came from

OW-54 moved the table rows into per-card files in three coherent phases: generation alongside the source tables in `7ece977`, documentation and procedure updates in `d82885f`, and removal of the tables in `5440377`.
The card closed in `ef1403d` after the generated corpus and repository references were checked while the source tables still existed.
Keeping source and output together until verification was load-bearing because the conversion could not be checked after deleting its input.

Tooling was intentionally decided after the storage had been used rather than bundled into the migration.
The project built its own tool instead of adopting beads because beads kept its primary data in one shared JSONL file and its autonomous work-claiming model did not match this repository's owner-selected execution.
OW-59 later produced the cross-project `card` CLI instead of a repository-local `ow` command.
The CLI owns operations that benefit from atomicity or a memorable interface; card contents and evidence remain prose because deciding what they mean is the human part of the work.

## Scope of this record

The original document also preserved exact conversion rules, obsolete grep commands, dated corpus counts, dry-run findings, completed phase instructions, design questions settled in the 2026-08-17 discussion, and a later tooling question answered by OW-59.
The procedural details were valuable while the migration could still fail; all of that material remains recoverable from the history of this file.
This synopsis keeps the rationale a current reader could otherwise recover only through commit archaeology, while leaving current behavior to the loaded instructions and the CLI's own contract.
