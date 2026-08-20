---
kind: deferral
where: '`src/shared/protocol.ts` `SessionSummary.preview` (`:79-80`), the session list in `src/client/App.svelte` (`:750`)'
---

# A forked session's row in the list is a character-for-character copy of its parent's, so the two cannot be told apart.

`SessionSummary.preview` is *"First user message, trimmed for display"*
(`protocol.ts:79`). A fork carries the history up to the fork point, so a
session forked at message 5 has the same first user message as its parent and
therefore the same preview -- identical rows, ordered by recency,
distinguishable only by timestamp. The single exception is a fork taken at the
first message, whose branch has no history at all and whose preview is the
edited text.

OW-hezidi is what makes this bite: it makes forking cheap enough to do often,
and every fork adds a twin.

**Deferred by the owner on 2026-08-19.** His judgement was that the answer is
to auto-hide some kinds of fork, which cannot be built before the hiding
exists -- that is OW-66. So this waits on OW-66 landing, and then on enough use
of forking to say *which* forks are the ones worth hiding, which is a verdict
to take from use rather than predict here.

Recorded so the constraint is findable rather than rediscovered, and so nobody
reads the identical rows as a bug in the list. Three alternatives were named in
passing and are written down only to save re-deriving them, not because any is
chosen: take the preview from the fork point rather than the start, mark
lineage on the row, or nest a fork under its parent.

## Revisit when

OW-66 has landed and edit-and-fork has been used for long enough that the
owner can say which forks he wants out of sight. Closing this means a decision
recorded where decisions go -- `DESIGN.md` if it moves D13's storage, this
file's close note otherwise -- not a UI tweak made in passing.

**Nothing is being lost while this waits (checked 2026-08-19).** The worry that
would argue for acting early -- that lineage has to be captured at fork time or
not at all -- does not hold. Agentpane records no parentage of its own (no
`parent`, `forkedFrom` or equivalent in `protocol.ts`, `src/server/sessions/`
or `session-manager.ts`), but both backends already write it into the session
file header, confirmed in the committed captures rather than from the type
declarations:

- **Codex**: `"forked_from_id"` inside `session_meta`
  (`resources/fixtures/codex/fork.jsonl`, first line); `Thread.forkedFromId`
  also exists in the vendored bindings.
- **Pi**: `"parentSession"` in the session header line
  (`resources/fixtures/pi/fork.jsonl`, first line).

In both cases the recorded parent is already in the form agentpane uses as a
ref -- a thread id for Codex, a JSONL path for Pi (D9) -- so no translation is
implied either. All three alternatives named above need exactly this one input,
and it is durably on disk for every fork already taken, retroactively readable
by the walk `src/server/sessions/` already performs.

So the work whenever the verdict arrives is to surface that field into
`SessionSummary` from the existing parsers and then decide presentation.
Waiting for use to say *which* forks deserve hiding costs nothing, which is
what one wants to be true of a deferral.
