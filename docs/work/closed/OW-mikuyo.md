---
labels: [deferral, emacs]
closed: declined
---

# A standalone read-only session browser in Emacs, talking to the HTTP API directly, is judged from use of the shim rather than built now

Filed 2026-09-13 from the owner's discussion of an Emacs client.
The owner values fast, non-attaching session previews and floated a separate reading-mode UI for them.

OW-basoga gets the feature inside `agent-shell` first: `session/load` served from `GET .../preview` spawns nothing, and `agent-shell-session-restore-verbosity` set to `full` renders the whole transcript on selection.
What that does not give is browsing many sessions quickly, since `agent-shell`'s picker is one `completing-read` and one load per session.

The deferred tool is the one piece of Emacs UI that would not go through the shim, and legitimately so: two GET requests (`/api/sessions`, `/api/sessions/:backend/:id/preview` from `src/shared/protocol.ts` `ROUTES`) and no stream, so none of the streaming rules apply.
A `tabulated-list-mode` buffer of sessions, a read-only preview buffer, and a key handing the id to `agent-shell-resume-session`.
Its cost is a second renderer for message blocks in elisp, which will not share `agent-shell`'s look and is a second thing to maintain.

Decide after using OW-basoga for a while.
Done when the decision is recorded here on close: either the picker was enough and this is declined, or the tool is filed as its own `change` card with the browsing need it met written down.

## Close note

Declined 2026-09-22 under D22 in `docs/DESIGN.md`, decided in OW-vibipo: the shim this card deferred behind is not built, so there is no use of it to judge from.
The browsing need it recorded, fast non-attaching previews over many sessions, is met head-on by the native stream: OW-wavone's first deliverable is a `tabulated-list-mode` session list and a read-only transcript buffer that spawns nothing, which is this card's deferred tool built as the mode's foundation rather than beside a shim.
The second-renderer cost this card named is the cost OW-dekate measured and the owner accepted.
