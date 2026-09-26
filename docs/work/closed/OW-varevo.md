---
labels: [deferral, emacs]
closed: done
---

# Where agentpane-mode lags the browser has never been surveyed, so the parity rule covers new work only

On 2026-09-23 the owner made the Emacs client first-class, at feature parity with the browser, and `AGENTS.md`, "Both clients", now makes every new user-facing capability land in both.
Nothing yet says where the two already differ.
The open `emacs` cards (`card list --open --label emacs`) are rendering details found in use, not a gap list, and a capability the browser has and `agentpane-mode` lacks was never filed as a gap, because until that day it was not one.
The owner deferred the survey the same day so it would not pull attention off the effort work (OW-kokalo).

The survey compares what a user can do and see in `src/client/` -- `App.svelte`, `controller.ts`, and the renderers under `src/client/render/` -- against `emacs/agentpane.el` and the helper's methods in `src/emacs/protocol.ts`.
It counts capabilities, not pixels: a thing one client lets a user do or see that the other does not.
Differences D22 or a card already settled on purpose, such as the browser-only pointer rule D14 is scoped to, are listed with where they were settled, not filed as gaps.

Done when every gap found is an open card -- labelled `emacs` when the Emacs client is the one behind -- and this card's close note lists them, with any difference kept on purpose beside the decision that keeps it.

## Close note

Surveyed on 2026-09-26 by a dispatched reader that compared `src/client/` against `emacs/agentpane.el`, `src/emacs/helper.ts`, `src/emacs/nodes.ts` and `src/emacs/protocol.ts`, capability by capability.
The session confirmed its claims at the code, and a second, adversarial reader checked every filed card's grounding, gap and done condition.
That second read killed one gap, OW-kirari, and corrected sixteen cards before this close.

## Where agentpane-mode lags the browser, each an open card labelled `emacs`

- OW-kihisa: edit an earlier message and fork with the edited text and its images.
- OW-jerege: Edit last message, and Stop and edit on a streaming Pi turn (blocked by OW-kihisa).
- OW-wozoju: mark which user messages are fork points (D20).
- OW-yosege: a command that closes a session's subprocess (`sessions/close`, which no elisp sends).
- OW-bupivi: a command that only attaches a preview.
- OW-kafupo: a preview that refreshes itself (OW-76).
- OW-sibevo: images drawn inline rather than as `[image <mime>]`.
- OW-gakide: open a live subagent's child thread (OW-benige).
- OW-zudihi: copy a block's markdown source.
- OW-yedipi: warn that a leading `/` is sent as text (OW-73).
- OW-lohavi: say that a submitted turn finished while the user was elsewhere (OW-diyuwu).
- OW-nufafi: the picker re-lists on `sessions/changed` before anything attaches; this also fixes the stale streaming dot OW-kirari was filed for.
- OW-metuko: a finished-turn marker in the picker (blocked by OW-nufafi).
- OW-bisadi: a workspace column in the picker.
- OW-fenina: filter the picker to any workspace.
- OW-sowume: label a just-prompted session by its first user message.
- OW-mareju: show that the helper's stream is down and reconnecting (needs a new notification).
- OW-yidapi: step between user messages only.
- OW-radoga: a new session from a transcript inherits its backend and workspace (OW-72).

## Where the browser lags agentpane-mode, each an open `change` card

- OW-sobutu: fork without sending a prompt.
- OW-zigepi: a draft per session.
- OW-hokika: show Bash's `description` and any other argument a renderer drops.
- OW-homeja: sort the session list by something other than recency.
- A session in a workspace no listed session uses can be created only from Emacs; that is OW-40, which the owner deferred on 2026-08-14 with "Do not build an affordance for this without asking", so nothing new was filed.

## Differences kept on purpose, beside what keeps them

- Emacs commands reachable only by key: D14, "a command reachable only by key is the ordinary shape of an Emacs mode".
- No external editor (`/api/edit-draft`) in Emacs: D22, where "long messages edited in place" is named among what "is Emacs's", and `agentpane-prompt` is that composer.
- Follow mode weaker in Emacs: the `agentpane--keeping-points` docstring, "deliberately less than the browser's".
- `f` on a preview attaches first and needs a second `f`, where the browser offers no Edit on a preview: the `agentpane-fork` docstring (OW-gekiki, the preview-versus-live index mismatch).
- Model and effort fixed after the first prompt, in both clients: D23.

## Absent from both clients, so not a parity gap

- Answering an agent's request (approval dialogs): D2a, provisional, revisited by OW-bijera; `requests/reply` sits unused in the helper.
- A child-thread link on a stored preview: D19, "no child link at all"; OW-kelise.
- Star or hide marks: D13, "Decided, not yet built", carried by OW-66. Rename: OW-jamaha.

## Looked at and judged not capability gaps

- The browser opens a thinking block while it streams, and Emacs keeps it folded; `TAB` shows it, so no information is missing.
- Several transcripts at once in Emacs windows, where the browser needs several tabs: both can do it.
- The browser shows a model's `label`, and Emacs its id; the browser shows busy text like "Sending prompt…", and Emacs mostly does not. Both are presentation.
- The picker's Updated column drops the seconds; that is formatting only.

## Doc defects the survey found, fixed in this change

- `docs/DESIGN.md` D23 named `agentpane--check-model-gate`; the function is `agentpane--check-gate`.
- The `emacs/agentpane.el` Commentary said the picker's filter works "as the browser's `?cwd=` query is"; the browser filters client-side and never sends `?cwd=`, and the sentence now says the filter goes "through the server's `?cwd=` query".
- The `sessionLabel` docblock in `src/client/App.svelte` still says only create, attach, rename and close emit `sessions-changed`, which OW-furinu made false; OW-sowume carries correcting it.
